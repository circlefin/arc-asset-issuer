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

import { OpenNewWindow } from "iconoir-react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";
import { shortenHex } from "@/lib/format";

type ExplorerLinkProps = { href: string; value: string };

// A shortened hash or address that opens the block explorer.
export function ExplorerLink({ href, value }: ExplorerLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: "link", size: "xs" }), "h-auto px-0 font-mono")}
    >
      {shortenHex(value)}
      <OpenNewWindow data-icon="inline-end" />
    </a>
  );
}
