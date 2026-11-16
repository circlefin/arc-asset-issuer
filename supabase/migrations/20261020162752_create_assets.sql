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

-- Assets and their saved progress: setup steps, issuer mints and transfers.
-- Everything is public to read, like the chain it mirrors. Only the wallet
-- that signed in can write, and only what belongs to it.

create schema private;
grant usage on schema private to authenticated;

-- The wallet the user signed in with, lowercase. Read from auth.identities,
-- because user metadata can be edited by the user.
create function private.wallet_address()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(split_part(identity.provider_id, ':', 3))
  from auth.identities as identity
  where identity.user_id = (select auth.uid())
    and identity.provider = 'web3'
    and identity.provider_id like 'web3:ethereum:%'
$$;

revoke execute on function private.wallet_address() from public;
grant execute on function private.wallet_address() to authenticated;

-- Lowercase, so comparing two addresses is plain equality.
create domain public.address as text
  check (value ~ '^0x[0-9a-f]{40}$' and value <> '0x0000000000000000000000000000000000000000');

create domain public.bytes32 as text check (value ~ '^0x[0-9a-f]{64}$');

-- Base units: a whole number that fits a uint256. No typmod, so a fraction fails instead of rounding.
create domain public.token_amount as numeric
  check (value >= 0 and value = trunc(value) and value < 2::numeric ^ 256);

create type public.asset_type as enum ('community', 'real-world');

create type public.rwa_category as enum (
  'Treasury bills',
  'Real estate',
  'Commodities',
  'Private credit'
);

create type public.chain as enum ('arc-testnet', 'base-sepolia');

-- In the order a transfer moves through them. A failed delivery can go back to delivering.
create type public.transfer_state as enum (
  'approval-required',
  'source-submitted',
  'awaiting-attestation',
  'delivering',
  'delivery-failed',
  'complete'
);

-- Limits match lib/assets.ts.
create table public.assets (
  -- Made by the browser before launch, so a retried launch can't create a second asset.
  id uuid primary key,
  issuer public.address not null,
  type public.asset_type not null,
  name text not null check (char_length(btrim(name)) between 1 and 32),
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,10}$'),
  description text not null check (char_length(btrim(description)) between 1 and 280),
  decimals smallint not null check (decimals between 0 and 18),
  -- The CCTP token ID, the same on every chain.
  cross_chain_id public.bytes32 not null unique,
  issuer_name text check (char_length(btrim(issuer_name)) > 0),
  category public.rwa_category,
  underlying_description text check (char_length(btrim(underlying_description)) > 0),
  document_url text check (document_url ~* '^https?://'),
  created_at timestamptz not null default now(),
  check (
    (type = 'real-world') =
    (issuer_name is not null and category is not null and underlying_description is not null)
  ),
  check (type = 'real-world' or document_url is null)
);

create index assets_issuer_index on public.assets (issuer);

-- One row per signed setup transaction.
create table public.setup_transactions (
  asset_id uuid not null references public.assets,
  -- Index into SETUP_STEPS in lib/assets.ts.
  step smallint not null check (step between 0 and 7),
  transaction_hash public.bytes32 not null unique,
  -- Set on the steps that deploy the token, the first on each chain.
  token_address public.address,
  created_at timestamptz not null default now(),
  primary key (asset_id, step),
  check ((step in (0, 4)) = (token_address is not null))
);

-- Every step done, on every chain. Mints and transfers wait for it.
create function private.is_setup_complete(asset_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  -- The length of SETUP_STEPS, matching the step check above.
  select count(*) = 8 from public.setup_transactions as done
  where done.asset_id = is_setup_complete.asset_id
$$;

revoke execute on function private.is_setup_complete(uuid) from public;
grant execute on function private.is_setup_complete(uuid) to authenticated;

create table public.issuer_mints (
  -- Made by the browser before signing, so a retry can't record the mint twice.
  id uuid primary key,
  asset_id uuid not null references public.assets,
  recipient public.address not null,
  amount public.token_amount not null check (amount > 0),
  transaction_hash public.bytes32 not null unique,
  created_at timestamptz not null default now()
);

create index issuer_mints_asset_index on public.issuer_mints (asset_id);
create index issuer_mints_recipient_index on public.issuer_mints (recipient);

create table public.transfers (
  -- Made by the browser before signing, so a retry can't start a second transfer.
  id uuid primary key,
  asset_id uuid not null references public.assets,
  sender public.address not null,
  recipient public.address not null,
  source_chain public.chain not null,
  destination_chain public.chain not null check (destination_chain <> source_chain),
  amount public.token_amount not null check (amount > 0),
  -- Taken out of the amount by CCTP. The recipient gets the rest.
  fee public.token_amount not null check (fee <= amount),
  state public.transfer_state not null default 'approval-required',
  -- The burn. Unique, so one burn can't back two transfers.
  source_transaction_hash public.bytes32 unique,
  -- The bridge mint, once delivered.
  destination_transaction_hash public.bytes32 unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'approval-required') = (source_transaction_hash is null)),
  check ((state = 'complete') = (destination_transaction_hash is not null))
);

-- Amounts arrive as text, since a JSON number can't hold every uint256 exactly.
create function public.record_issuer_mint(
  id uuid,
  asset_id uuid,
  recipient text,
  amount text,
  transaction_hash text
)
returns void
language sql
set search_path = ''
as $$
  insert into public.issuer_mints (id, asset_id, recipient, amount, transaction_hash)
  values (id, asset_id, recipient, amount::public.token_amount, transaction_hash);
$$;

create function public.start_transfer(
  id uuid,
  asset_id uuid,
  sender text,
  recipient text,
  source_chain public.chain,
  destination_chain public.chain,
  amount text,
  fee text
)
returns void
language sql
set search_path = ''
as $$
  insert into public.transfers
    (id, asset_id, sender, recipient, source_chain, destination_chain, amount, fee)
  values (
    id, asset_id, sender, recipient, source_chain, destination_chain,
    amount::public.token_amount, fee::public.token_amount
  );
$$;

create index transfers_asset_index on public.transfers (asset_id);
create index transfers_sender_index on public.transfers (sender);
create index transfers_recipient_index on public.transfers (recipient);

-- A transfer only moves forward, and a recorded burn or mint never changes.
-- Retrying a failed delivery is the one step back.
create function private.check_transfer_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'complete' then
    raise exception 'Transfer % is already complete', old.id;
  end if;
  if new.state < old.state and not (old.state = 'delivery-failed' and new.state = 'delivering') then
    raise exception 'Transfer % can''t go from % back to %', old.id, old.state, new.state;
  end if;
  if old.source_transaction_hash is distinct from new.source_transaction_hash
    and old.source_transaction_hash is not null then
    raise exception 'Transfer % already has a source transaction', old.id;
  end if;
  if old.destination_transaction_hash is distinct from new.destination_transaction_hash
    and old.destination_transaction_hash is not null then
    raise exception 'Transfer % already has a destination transaction', old.id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger transfers_check_progress
  before update on public.transfers
  for each row execute function private.check_transfer_progress();

-- Least access: read everything, insert as yourself, and only move a transfer's progress.
revoke all on public.assets, public.setup_transactions, public.issuer_mints, public.transfers
  from anon, authenticated;
grant select on public.assets, public.setup_transactions, public.issuer_mints, public.transfers
  to anon, authenticated;
grant insert on public.assets, public.setup_transactions, public.issuer_mints, public.transfers
  to authenticated;
grant update (state, source_transaction_hash, destination_transaction_hash) on public.transfers
  to authenticated;
revoke execute on function public.record_issuer_mint, public.start_transfer from public, anon;
grant execute on function public.record_issuer_mint, public.start_transfer to authenticated;

alter table public.assets enable row level security;
alter table public.setup_transactions enable row level security;
alter table public.issuer_mints enable row level security;
alter table public.transfers enable row level security;

create policy "Anyone can read assets"
  on public.assets for select to anon, authenticated using (true);

create policy "Wallets launch assets as their issuer"
  on public.assets for insert to authenticated
  with check (issuer = (select private.wallet_address()));

create policy "Anyone can read setup transactions"
  on public.setup_transactions for select to anon, authenticated using (true);

-- Only the issuer, and only the next step in order.
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
    )
  );

create policy "Anyone can read issuer mints"
  on public.issuer_mints for select to anon, authenticated using (true);

create policy "Issuers record their own mints"
  on public.issuer_mints for insert to authenticated
  with check (
    exists (
      select 1 from public.assets as asset
      where asset.id = asset_id and asset.issuer = (select private.wallet_address())
    )
    and private.is_setup_complete(asset_id)
  );

create policy "Anyone can read transfers"
  on public.transfers for select to anon, authenticated using (true);

create policy "Senders start their own transfers"
  on public.transfers for insert to authenticated
  with check (
    sender = (select private.wallet_address())
    and state = 'approval-required'
    and private.is_setup_complete(asset_id)
  );

create policy "Senders move their own transfers forward"
  on public.transfers for update to authenticated
  using (sender = (select private.wallet_address()))
  with check (sender = (select private.wallet_address()));

-- Token images. Public to read, and each wallet uploads only into its own folder.
-- Formats and size follow pump.fun. No SVG, since it can carry script.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'asset-images',
  'asset-images',
  true,
  15 * 1024 * 1024,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
);

create policy "Wallets upload asset images into their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'asset-images'
    and (storage.foldername(name))[1] = (select private.wallet_address())
  );
