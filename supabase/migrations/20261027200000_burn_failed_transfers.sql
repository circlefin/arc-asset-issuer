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

-- A burn the wallet cancelled or replaced, or that reverted, never left the sender's wallet. The
-- transfer ends there, keeping the burn's hash, and the sender starts a new one.

alter type public.transfer_state add value 'burn-failed';

create or replace function private.check_transfer_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'complete' then
    raise exception 'Transfer % is already complete', old.id;
  end if;
  if old.state = 'burn-failed' then
    raise exception 'Transfer % ended when its burn failed', old.id;
  end if;
  -- Only a submitted burn can turn out to have failed. Later states saw it land.
  if new.state = 'burn-failed' and old.state <> 'source-submitted' then
    raise exception 'Transfer % can''t go from % to burn-failed', old.id, old.state;
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
