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

-- "5.0" passed the whole-number check but kept its scale, so it read back as "5.0", which
-- BigInt refuses: one such row broke the asset's page for everyone. Base units have no scale.
-- If this fails on a deployed database, some row holds a scaled amount. Normalise it first, in a
-- dedicated migration that disables the progress triggers (they block updates), then apply this.
alter domain public.token_amount
  add constraint token_amount_no_scale check (scale(value) = 0);
