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

-- Saves the CCTP salt, and sets up on Arc only until Base is added.

-- The cross-chain ID comes from the issuer and this salt. Registering on another
-- chain needs the same salt, so a resumed setup has to be able to read it back.
alter table public.assets add column salt public.bytes32 not null;

-- Arc only until Base is added: four steps, and only the first deploys a token.
alter table public.setup_transactions
  drop constraint setup_transactions_step_check,
  add constraint setup_transactions_step_check check (step between 0 and 3),
  drop constraint setup_transactions_check,
  add constraint setup_transactions_check check ((step = 0) = (token_address is not null));

create or replace function private.is_setup_complete(asset_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  -- The length of SETUP_STEPS, matching the step check above. Arc only until Base is added.
  select count(*) = 4 from public.setup_transactions as done
  where done.asset_id = is_setup_complete.asset_id
$$;
