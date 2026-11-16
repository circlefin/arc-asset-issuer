/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { fetchAsset } from "@/lib/records";
import { ASSETS_QUERY_KEY } from "./asset-store";
import { useWallet } from "./wallet";

// Undefined while loading. A missing asset is a 404.
export function useAssetRecord(assetId: string) {
  const { address } = useWallet();
  const { data } = useQuery({
    queryKey: [...ASSETS_QUERY_KEY, "one", assetId, address],
    queryFn: () => fetchAsset(assetId, address),
  });
  if (data === null) notFound();
  return data;
}

export function useAsset(assetId: string) {
  return useAssetRecord(assetId)?.asset;
}
