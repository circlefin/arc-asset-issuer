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

-- Saves a mint as soon as the wallet sends it, before it lands. A retry or a refresh then
-- waits for that transaction instead of sending another.

create type public.mint_state as enum ('pending', 'confirmed', 'reverted');

alter table public.issuer_mints add column state public.mint_state not null default 'pending';

-- Waiting is the only way in, a confirmed mint never changes, and a reverted one can only be
-- sent again under a new transaction. A mint the wallet sped up ends under its new hash.
create function private.check_mint_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The same outcome saved twice, by a retry.
  if new.state = old.state and new.transaction_hash = old.transaction_hash then
    return new;
  end if;
  if old.state = 'pending' and new.state <> 'pending' then
    return new;
  end if;
  if old.state = 'reverted' and new.state = 'pending'
    and new.transaction_hash <> old.transaction_hash then
    return new;
  end if;
  raise exception 'Mint % can''t go from % to %', old.id, old.state, new.state;
end;
$$;

create trigger issuer_mints_check_progress
  before update on public.issuer_mints
  for each row execute function private.check_mint_progress();

grant update (state, transaction_hash) on public.issuer_mints to authenticated;

drop policy "Issuers record their own mints" on public.issuer_mints;

create policy "Issuers record their own mints"
  on public.issuer_mints for insert to authenticated
  with check (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
    and private.is_setup_complete(asset_id)
    and state = 'pending'
  );

create policy "Issuers record what happened to their mints"
  on public.issuer_mints for update to authenticated
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
