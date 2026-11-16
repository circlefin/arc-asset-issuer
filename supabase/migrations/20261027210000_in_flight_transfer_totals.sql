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

-- What each asset's saved transfers burned and haven't delivered, summed here so the API's row
-- cap can't cut the sum short. The states match IN_FLIGHT_STATES in lib/cctp/holdings.ts, and a
-- test there checks they do. Amounts leave as text, since a JSON number can't hold every uint256
-- exactly. One row per asset asked for: zero only when the asset has no transfer in flight.
-- Runs as the caller, so it sums only the rows the caller can already read.
create function public.in_flight_transfer_totals(asset_ids uuid[])
returns table (asset_id uuid, amount text)
language sql
stable
security invoker
set search_path = ''
as $$
  select asked.id, coalesce(sum(transfer.amount), 0)::text
  -- Distinct, so an asset asked for twice isn't summed twice.
  from (select distinct unnest(in_flight_transfer_totals.asset_ids)) as asked (id)
  left join public.transfers as transfer
    on transfer.asset_id = asked.id
    and transfer.state in ('source-submitted', 'awaiting-attestation', 'delivering', 'delivery-failed')
  group by asked.id;
$$;

-- Readable by the same roles that can read transfers.
revoke execute on function public.in_flight_transfer_totals from public;
grant execute on function public.in_flight_transfer_totals to anon, authenticated;
