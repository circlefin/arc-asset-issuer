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

import type { Session } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState } from "react";
import { getAddress, isAddressEqual, type Address } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import {
  useConnect,
  useConnection,
  useDisconnect,
  useSignMessage,
  type Connector,
} from "wagmi";
import { supabase } from "@/lib/supabase";
import { APP_NAME } from "./constants";

const SIGN_IN_STATEMENT = `Sign in to ${APP_NAME} to save your assets and their progress.`;
const SIWE_VERSION = "1";
// How Supabase names a wallet sign-in, followed by the address.
const WALLET_IDENTITY_PREFIX = "web3:ethereum:";

type WalletStatus =
  // Reconnecting the wallet or reading the saved session.
  | "loading"
  | "disconnected"
  // Connected, but not signed in as this wallet.
  | "signed-out"
  | "signed-in";

type WalletContextValue = {
  status: WalletStatus;
  // Only set once signed in, since saving anything needs the session.
  address: Address | null;
  // The wallet's current account, signed in or not.
  connectedAddress: Address | null;
  connect: (connector: Connector) => Promise<void>;
  signIn: () => Promise<void>;
  disconnect: () => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function sessionWallet(session: Session | null): Address | null {
  const identity = session?.user.identities?.find((entry) =>
    entry.id.startsWith(WALLET_IDENTITY_PREFIX),
  );
  return identity ? getAddress(identity.id.slice(WALLET_IDENTITY_PREFIX.length)) : null;
}

// Undefined until Supabase has read the saved session.
function useSession() {
  const [session, setSession] = useState<Session | null>();
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) =>
      setSession(nextSession),
    );
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

// A browser wallet, signed in to Supabase with Sign in with Ethereum so the database knows who writes.
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const connection = useConnection();
  const session = useSession();
  const { mutateAsync: connectWallet } = useConnect();
  const { mutateAsync: disconnectWallet } = useDisconnect();
  const { mutateAsync: signMessage } = useSignMessage();
  const signedInAs = session === undefined ? null : sessionWallet(session);

  function statusOf(): WalletStatus {
    if (session === undefined) return "loading";
    if (connection.status === "connecting" || connection.status === "reconnecting") {
      return "loading";
    }
    if (connection.status === "disconnected") return "disconnected";
    return signedInAs && isAddressEqual(signedInAs, connection.address)
      ? "signed-in"
      : "signed-out";
  }

  async function signInAs(address: Address, chainId: number) {
    if (signedInAs && isAddressEqual(signedInAs, address)) return;
    const message = createSiweMessage({
      address,
      chainId,
      domain: window.location.host,
      // Supabase only accepts messages for its allowed redirect URLs.
      uri: `${window.location.origin}/`,
      nonce: generateSiweNonce(),
      version: SIWE_VERSION,
      statement: SIGN_IN_STATEMENT,
      issuedAt: new Date(),
    });
    const signature = await signMessage({ account: address, message });
    const { error } = await supabase.auth.signInWithWeb3({ chain: "ethereum", message, signature });
    if (error) throw error;
  }

  const status = statusOf();
  const value: WalletContextValue = {
    status,
    address: status === "signed-in" ? (connection.address ?? null) : null,
    connectedAddress: connection.address ?? null,
    connect: async (connector) => {
      const { accounts, chainId } = await connectWallet({ connector });
      await signInAs(accounts[0], chainId);
    },
    signIn: async () => {
      if (connection.status !== "connected") throw new Error("Connect a wallet first.");
      await signInAs(connection.address, connection.chainId);
    },
    disconnect: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      await disconnectWallet();
    },
  };

  return <WalletContext value={value}>{children}</WalletContext>;
}

export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet must be used inside WalletProvider");
  return wallet;
}
