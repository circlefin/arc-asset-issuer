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

import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { Wallet } from "iconoir-react";
import { useState } from "react";
import { useConnectors, type Connector } from "wagmi";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { shortenHex } from "@/lib/format";
import { ErrorAlert } from "./error-alert";
import { useWallet } from "./wallet";

const WALLET_DOWNLOAD_URL = "https://metamask.io/download";
const SIGNATURE_IS_FREE = "Signing is free and sends no transaction.";

type WalletAction =
  | { kind: "connect"; connector: Connector }
  | { kind: "sign-in" }
  | { kind: "disconnect" };

type StepProps = { walletAction: UseMutationResult<void, Error, WalletAction> };

type ConnectWalletButtonProps = Omit<React.ComponentProps<typeof Button>, "onClick">;

// Connects a browser wallet, then signs in with it. Reads "Sign in" when the wallet is connected but not signed in.
export function ConnectWalletButton(props: ConnectWalletButtonProps) {
  const { status, connect, signIn, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  // One mutation for every step, so the latest error stays shown even when the step changes,
  // as when connecting works but signing is declined.
  const walletAction = useMutation({
    mutationFn: (action: WalletAction) => {
      if (action.kind === "connect") return connect(action.connector);
      if (action.kind === "sign-in") return signIn();
      return disconnect();
    },
    onSuccess: () => setOpen(false),
  });

  return (
    <>
      <Button
        {...props}
        disabled={status === "loading"}
        onClick={() => {
          walletAction.reset();
          setOpen(true);
        }}
      >
        {status === "loading" ? <Spinner data-icon="inline-start" /> : <Wallet data-icon="inline-start" />}
        {status === "signed-out" ? "Sign in" : "Connect wallet"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          {status === "signed-out" ? (
            <SignInStep walletAction={walletAction} />
          ) : (
            <ChooseWalletStep walletAction={walletAction} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChooseWalletStep({ walletAction }: StepProps) {
  const connectors = useConnectors();
  const { isPending, variables } = walletAction;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect a wallet</DialogTitle>
        <DialogDescription>
          Pick a browser wallet, then sign a message to prove it&apos;s yours. {SIGNATURE_IS_FREE}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {connectors.length === 0 ? (
          <NoWalletFound />
        ) : (
          <ItemGroup className="gap-2">
            {connectors.map((connector) => (
              <WalletOption
                key={connector.uid}
                connector={connector}
                pending={isPending && variables.kind === "connect" && variables.connector === connector}
                disabled={isPending}
                onSelect={() => walletAction.mutate({ kind: "connect", connector })}
              />
            ))}
          </ItemGroup>
        )}
        {isPending && (
          <p className="text-muted-foreground">Check your wallet to connect and sign.</p>
        )}
        {walletAction.error && <ErrorAlert error={walletAction.error} />}
      </DialogBody>
    </>
  );
}

type WalletOptionProps = {
  connector: Connector;
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
};

function WalletOption({ connector, pending, disabled, onSelect }: WalletOptionProps) {
  return (
    <Item
      variant="outline"
      render={<button type="button" disabled={disabled} onClick={onSelect} />}
    >
      <ItemMedia>
        <Avatar size="sm">
          {connector.icon && <AvatarImage src={connector.icon} alt="" />}
          <AvatarFallback>{connector.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{connector.name}</ItemTitle>
      </ItemContent>
      {pending && <Spinner />}
    </Item>
  );
}

function NoWalletFound() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Wallet />
        </EmptyMedia>
        <EmptyTitle>No browser wallet found</EmptyTitle>
        <EmptyDescription>
          Install one, such as <a href={WALLET_DOWNLOAD_URL} target="_blank" rel="noreferrer">MetaMask</a>,
          then reload this page.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SignInStep({ walletAction }: StepProps) {
  const { connectedAddress } = useWallet();
  const { isPending, variables } = walletAction;
  const signingIn = isPending && variables.kind === "sign-in";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign in</DialogTitle>
        <DialogDescription>
          Sign a message to prove you own{" "}
          <span className="font-mono">{connectedAddress && shortenHex(connectedAddress)}</span>.{" "}
          {SIGNATURE_IS_FREE}
        </DialogDescription>
      </DialogHeader>
      {walletAction.error && (
        <DialogBody>
          <ErrorAlert error={walletAction.error} />
        </DialogBody>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          disabled={isPending}
          onClick={() => walletAction.mutate({ kind: "disconnect" })}
        >
          Disconnect
        </Button>
        <Button disabled={isPending} onClick={() => walletAction.mutate({ kind: "sign-in" })}>
          {signingIn && <Spinner data-icon="inline-start" />}
          {signingIn ? "Check your wallet…" : "Sign in"}
        </Button>
      </DialogFooter>
    </>
  );
}
