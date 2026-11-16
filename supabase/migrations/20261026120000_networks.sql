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

-- Sets an asset up one network at a time. Arc comes first, since tokens launch there, and
-- every transfer moves between Arc and one other enabled network.

-- Every CCTP testnet, spelled like ChainId in lib/chains.ts.
alter type public.chain add value 'ethereum-sepolia';
alter type public.chain add value 'avalanche-fuji';
alter type public.chain add value 'op-sepolia';
alter type public.chain add value 'arbitrum-sepolia';
alter type public.chain add value 'polygon-amoy';

-- Steps saved before this were all on Arc.
alter table public.setup_transactions
  add column chain public.chain not null default 'arc-testnet';
alter table public.setup_transactions alter column chain drop default;

-- Steps count from 0 on each chain. The step and token address checks are per row, so they
-- already hold within each chain: four steps, and the first one's deploy saves the token.
alter table public.setup_transactions
  drop constraint setup_transactions_pkey,
  add primary key (asset_id, chain, step);

-- Every step done on that chain. Transfers to and from it wait for it.
create function private.is_chain_enabled(asset_id uuid, chain public.chain)
returns boolean
language sql
stable
set search_path = ''
as $$
  -- The length of setupStepsOn(chain), matching the step check.
  select count(*) = 4 from public.setup_transactions as done
  where done.asset_id = is_chain_enabled.asset_id
    and done.chain = is_chain_enabled.chain
    and done.state = 'confirmed'
$$;

revoke execute on function private.is_chain_enabled(uuid, public.chain) from public;
grant execute on function private.is_chain_enabled(uuid, public.chain) to authenticated;

-- Minting happens on Arc, so it waits for Arc only.
create or replace function private.is_setup_complete(asset_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.is_chain_enabled(is_setup_complete.asset_id, 'arc-testnet')
$$;

create or replace function private.check_setup_step_progress()
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
  raise exception 'Setup step % on % of asset % can''t go from % to %',
    old.step, old.chain, old.asset_id, old.state, new.state;
end;
$$;

drop policy "Issuers record their next setup step" on public.setup_transactions;

-- Only the issuer, only the step after the last confirmed one on that chain, and another
-- chain only once Arc is set up.
create policy "Issuers record their next setup step"
  on public.setup_transactions for insert to authenticated
  with check (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
    and step = (
      select count(*) from public.setup_transactions as done
      where done.asset_id = setup_transactions.asset_id
        and done.chain = setup_transactions.chain
        and done.state = 'confirmed'
    )
    and state = 'pending'
    and (chain = 'arc-testnet' or private.is_chain_enabled(asset_id, 'arc-testnet'))
  );

-- CCTP's fee comes out of the gas paid on the source chain, not the amount sent.
alter table public.transfers rename column fee to cross_chain_fee;
alter table public.transfers drop constraint transfers_check1;
comment on column public.transfers.cross_chain_fee is 'Paid in the source chain''s gas token';

drop function public.start_transfer(uuid, uuid, text, text, public.chain, public.chain, text, text);

create function public.start_transfer(
  id uuid,
  asset_id uuid,
  sender text,
  recipient text,
  source_chain public.chain,
  destination_chain public.chain,
  amount text,
  cross_chain_fee text
)
returns void
language sql
set search_path = ''
as $$
  insert into public.transfers
    (id, asset_id, sender, recipient, source_chain, destination_chain, amount, cross_chain_fee)
  values (
    id, asset_id, sender, recipient, source_chain, destination_chain,
    amount::public.token_amount, cross_chain_fee::public.token_amount
  );
$$;

revoke execute on function public.start_transfer from public, anon;
grant execute on function public.start_transfer to authenticated;

drop policy "Senders start their own transfers" on public.transfers;

-- Hub and spoke: one end is Arc, and both ends are set up.
create policy "Senders start their own transfers"
  on public.transfers for insert to authenticated
  with check (
    sender = (select private.wallet_address())
    and state = 'approval-required'
    and (source_chain = 'arc-testnet') <> (destination_chain = 'arc-testnet')
    and private.is_chain_enabled(asset_id, source_chain)
    and private.is_chain_enabled(asset_id, destination_chain)
  );
