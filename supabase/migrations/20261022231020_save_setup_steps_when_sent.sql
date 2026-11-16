-- Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
-- SPDX-License-Identifier: Apache-2.0

-- Saves each setup step as soon as the wallet sends it, before it lands. A refresh then waits
-- for that transaction instead of sending the step again.

create type public.setup_step_state as enum ('pending', 'confirmed', 'reverted');

-- Steps saved before this were saved once they had succeeded.
alter table public.setup_transactions
  add column state public.setup_step_state not null default 'confirmed';
alter table public.setup_transactions alter column state set default 'pending';

-- The deploy's token address is only known once it lands.
alter table public.setup_transactions
  drop constraint setup_transactions_check,
  add constraint setup_transactions_check
    check ((step = 0 and state = 'confirmed') = (token_address is not null));

create or replace function private.is_setup_complete(asset_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  -- The length of SETUP_STEPS, matching the step check. Arc only until Base is added.
  select count(*) = 4 from public.setup_transactions as done
  where done.asset_id = is_setup_complete.asset_id and done.state = 'confirmed'
$$;

-- Waiting is the only way in, a confirmed step never changes, and a reverted one can only be
-- sent again under a new transaction. A step the wallet sped up ends under its new hash.
create function private.check_setup_step_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The same outcome saved twice, by a retry.
  if new.state = old.state and new.transaction_hash = old.transaction_hash
    and new.token_address is not distinct from old.token_address then
    return new;
  end if;
  if old.state = 'pending' and new.state <> 'pending' then
    return new;
  end if;
  if old.state = 'reverted' and new.state = 'pending'
    and new.transaction_hash <> old.transaction_hash then
    return new;
  end if;
  raise exception 'Setup step % of asset % can''t go from % to %',
    old.step, old.asset_id, old.state, new.state;
end;
$$;

create trigger setup_transactions_check_progress
  before update on public.setup_transactions
  for each row execute function private.check_setup_step_progress();

grant update (state, transaction_hash, token_address) on public.setup_transactions to authenticated;

drop policy "Issuers record their next setup step" on public.setup_transactions;

-- Only the issuer, and only the step after the last confirmed one.
create policy "Issuers record their next setup step"
  on public.setup_transactions for insert to authenticated
  with check (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
    and step = (
      select count(*) from public.setup_transactions as done
      where done.asset_id = setup_transactions.asset_id and done.state = 'confirmed'
    )
    and state = 'pending'
  );

create policy "Issuers record how their setup steps ended"
  on public.setup_transactions for update to authenticated
  using (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
  )
  with check (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
  );
