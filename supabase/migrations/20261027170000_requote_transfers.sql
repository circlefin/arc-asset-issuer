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

-- A transfer resumed before its burn is quoted again, since quotes expire in minutes. The fee
-- saved is the one the burn pays, so it may change until the burn is saved, and never after.

grant update (cross_chain_fee) on public.transfers to authenticated;

create or replace function private.check_transfer_progress()
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
  if old.cross_chain_fee is distinct from new.cross_chain_fee
    and not (old.state = 'approval-required' and new.state = 'approval-required') then
    raise exception 'Transfer % can only change its fee before its burn is saved', old.id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Amounts arrive as text, since a JSON number can't hold every uint256 exactly. Runs as the
-- caller, so only the sender's own row changes, and the trigger above still applies.
create function public.save_transfer_fee(id uuid, cross_chain_fee text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.transfers
  set cross_chain_fee = save_transfer_fee.cross_chain_fee::public.token_amount
  where transfers.id = save_transfer_fee.id;
  if not found then
    raise exception 'Only the sender can update transfer %', save_transfer_fee.id;
  end if;
end;
$$;

revoke execute on function public.save_transfer_fee from public, anon;
grant execute on function public.save_transfer_fee to authenticated;
