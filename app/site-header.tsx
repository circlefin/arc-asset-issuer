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

import { useMutation } from "@tanstack/react-query";
import { Check, Copy, LogOut, Wallet } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { shortenHex } from "@/lib/format";
import { ConnectWalletButton } from "./connect-wallet";
import { useWallet } from "./wallet";

const COPIED_LABEL_MS = 2000;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger />
      <div className="ml-auto">
        <WalletButton />
      </div>
    </header>
  );
}

function WalletButton() {
  const { address, disconnect } = useWallet();
  // Thrown in render, so a failed sign-out reaches the error page instead of vanishing.
  const disconnecting = useMutation({ mutationFn: disconnect, throwOnError: true });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!address) return <ConnectWalletButton />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <Wallet data-icon="inline-start" />
        <span className="font-mono">{shortenHex(address)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Stays open on click so the label can confirm the copy. */}
        <DropdownMenuItem
          closeOnClick={false}
          onClick={async () => {
            await navigator.clipboard.writeText(address);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disconnecting.isPending} onClick={() => disconnecting.mutate()}>
          <LogOut />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
