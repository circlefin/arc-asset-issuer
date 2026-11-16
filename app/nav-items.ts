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

import { Activity, ViewGrid } from "iconoir-react";
import type { Icon } from "@/lib/icon";

export const MY_ASSETS_PATH = "/";
export const ACTIVITY_PATH = "/activity";

export function assetPath(assetId: string) {
  return `/assets/${assetId}`;
}

export type NavItem = { label: string; href: string; icon: Icon };

export const NAV_ITEMS: NavItem[] = [
  { label: "My assets", href: MY_ASSETS_PATH, icon: ViewGrid },
  { label: "Activity", href: ACTIVITY_PATH, icon: Activity },
];

// My assets also owns each asset's pages.
export function isActivePath(pathname: string, href: string) {
  if (href === MY_ASSETS_PATH) {
    return pathname === MY_ASSETS_PATH || pathname.startsWith("/assets/");
  }
  return pathname === href;
}
