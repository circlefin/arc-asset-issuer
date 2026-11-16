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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef, useState } from "react";
import type { Address, Hash } from "viem";
import { useConfig } from "wagmi";
import type { IssuerMintActivity, TransferActivity } from "@/lib/activity";
import type { SavedAsset } from "@/lib/assets";
import { createIris } from "@/lib/cctp/iris";
import {
  finishMint,
  mintOnce,
  saveUnsavedMint,
  sendIssuerMint,
  type MintRecords,
  type UnsavedMintSlot,
} from "@/lib/cctp/mint";
import { computeCrossChainId, continueSetup } from "@/lib/cctp/setup";
import {
  advanceTransfer,
  isForwardDelivered,
  isForwarding,
  quoteTransfer,
  sendTransfer,
  type DeliveryRecords,
  type TransferOrder,
  type TransferRecords,
} from "@/lib/cctp/transfer";
import { publicFor } from "@/lib/cctp/wallet";
import { ARC_TESTNET, CHAINS, findChain, type Chain, type ChainId } from "@/lib/chains";
import { describeError } from "@/lib/format";
import {
  fetchActivity,
  fetchInFlightTransfersBy,
  fetchIssuedAssets,
  fetchMint,
  fetchSavedAsset,
  fetchSenderTransfers,
  fetchTransfer,
  saveMintProgress,
  saveNewAsset,
  saveNewTransfer,
  saveSentMint,
  saveSentSetupStep,
  saveSetupStepProgress,
  saveTransferFee,
  saveTransferProgress,
  type NewAsset,
} from "@/lib/records";
import {
  findUnsavedMint,
  forgetUnsavedMint,
  rememberUnsavedMint,
  UnsavedMintError,
  unsavedMintsOf,
} from "@/lib/unsaved-mints";
import { findUnsavedStep, forgetUnsavedStep, rememberUnsavedStep } from "@/lib/unsaved-setup-steps";
import {
  findUnsavedDelivery,
  findUnsavedTransfer,
  forgetUnsavedDelivery,
  forgetUnsavedTransfer,
  rememberUnsavedDelivery,
  rememberUnsavedTransfer,
} from "@/lib/unsaved-transfers";
import { useWallet } from "./wallet";

// Every saved read sits under this key, so one invalidation refreshes them all.
export const ASSETS_QUERY_KEY = ["assets"];

// A setup runs, and fails, per asset and network, so Arc's launch and each network are tracked apart.
export function setupKey(assetId: string, chainId: ChainId) {
  return `${assetId}:${chainId}`;
}

// Whether any of the asset's setups runs. One runs per asset at a time, since each asks the same
// wallet to sign, so every Enable and Resume waits while one does.
export function isAnySetupRunning(runningSetups: string[], assetId: string) {
  return CHAINS.some((chain) => runningSetups.includes(setupKey(assetId, chain.id)));
}

export function useIssuedAssets(issuer: Address) {
  return useQuery({
    queryKey: [...ASSETS_QUERY_KEY, "issued", issuer],
    queryFn: () => fetchIssuedAssets(issuer),
  });
}

export function useActivity(wallet: Address) {
  return useQuery({
    queryKey: [...ASSETS_QUERY_KEY, "activity", wallet],
    queryFn: () => fetchActivity(wallet),
  });
}

export type MintOrder = {
  // Made before signing, so a retry records the same mint.
  id: string;
  assetId: string;
  recipient: Address;
  amount: bigint;
};

// The cross-chain ID is worked out from the issuer and salt, so the browser doesn't pick it.
export type LaunchRequest = Omit<NewAsset, "crossChainId">;

export type TransferRequest = {
  // Made before signing, so a retry can't start a second transfer.
  id: string;
  assetId: string;
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  recipient: Address;
  amount: bigint;
};

export type TransferQuote = Awaited<ReturnType<typeof quoteTransfer>>;

type AssetStore = {
  // By setupKey.
  runningSetups: string[];
  runningMints: string[];
  runningTransfers: string[];
  // Why the last run of a setup, mint or transfer stopped, by setupKey, mint or transfer ID.
  failures: Partial<Record<string, string>>;
  launchAsset: (asset: LaunchRequest) => Promise<void>;
  resumeSetup: (asset: SavedAsset, chain: Chain) => void;
  // Sets the asset up on another network, after Arc, so holders can move it there.
  enableNetwork: (asset: SavedAsset, chain: Chain) => void;
  mint: (order: MintOrder) => Promise<Hash>;
  // Waits for a mint sent before a refresh, and saves how it ended.
  finishMint: (mint: IssuerMintActivity) => void;
  // Why a mint held since before a reload couldn't be saved, or null.
  unsavedMintFailure: Error | null;
  retryUnsavedMints: () => void;
  // Stops saving a held mint. It stays minted onchain, but never shows in Activity.
  discardUnsavedMint: (mintId: string) => void;
  // Circle's fee and the source gas, in the source's native token. Throws what would stop the transfer.
  quoteTransfer: (request: TransferRequest, sender: Address) => Promise<TransferQuote>;
  // Approves, quotes and burns, and resolves once the burn is saved as submitted. Delivery is
  // then tracked in the background.
  startTransfer: (request: TransferRequest, sender: Address) => Promise<void>;
  // Picks a transfer up from its saved state: the burn if it has none, then delivery. Retrying a
  // failed delivery is this too, and never burns again.
  continueTransfer: (transfer: TransferActivity) => void;
  // Whether Circle delivers the transfer, from Iris. Null until Iris has attested its saved burn.
  findForwarding: (transfer: TransferActivity) => Promise<boolean | null>;
};

const AssetStoreContext = createContext<AssetStore | null>(null);

// Circle's attestation and fee-quote API. It allows cross-origin calls, so the browser asks it directly.
const iris = createIris();

// Saves every step to the database, so progress survives a refresh. Setup runs for real on
// every network, minting on Arc, and a transfer from its burn to its delivery.
export function AssetStoreProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const wagmiConfig = useConfig();
  const [runningSetups, setRunningSetups] = useState<string[]>([]);
  const [runningMints, setRunningMints] = useState<string[]>([]);
  const [runningTransfers, setRunningTransfers] = useState<string[]>([]);
  const [failures, setFailures] = useState<Partial<Record<string, string>>>({});
  // Read synchronously, so a second click can't start the same run twice.
  const running = useRef(new Set<string>());
  const { address } = useWallet();

  // Saves the issuer's mints a reload cut off before they were saved. Once per sign-in. A
  // failure is shown on every page, not thrown, so one mint that won't save can't lock the app.
  const unsavedMints = useQuery({
    queryKey: ["unsaved-mints", address],
    enabled: address !== null,
    staleTime: Infinity,
    throwOnError: false,
    queryFn: async () => {
      const unsaved = address ? unsavedMintsOf(address) : [];
      for (const mint of unsaved) {
        try {
          await saveUnsavedMint(mint.transactionHash, mintRecords(mint));
        } catch (error) {
          throw new UnsavedMintError(mint, error);
        }
        forgetUnsavedMint(mint.id);
      }
      return unsaved.length;
    },
  });

  // Finishes the sender's transfers Circle delivered while the app was closed, so they don't stay
  // in flight until each is reopened. Once per sign-in. Only a delivery Iris reports complete is
  // picked up, so the wallet is never asked. A transfer that can't be checked is left as it was,
  // with its Resume, and why is kept here for debugging.
  useQuery({
    queryKey: ["delivered-transfers", address],
    enabled: address !== null,
    staleTime: Infinity,
    throwOnError: false,
    queryFn: async () => {
      const transfers = address ? await fetchInFlightTransfersBy(address) : [];
      for (const transfer of transfers) {
        try {
          if (await isDeliveredByCircle(transfer)) continueTransfer(transfer);
        } catch (error) {
          console.error(error);
        }
      }
      return transfers.length;
    },
  });

  async function isDeliveredByCircle(transfer: TransferActivity) {
    if (!transfer.sourceTransactionHash) return false;
    const route = { source: findChain(transfer.sourceChainId), destination: findChain(transfer.destinationChainId) };
    const found = await iris.findMessage(route, transfer.sourceTransactionHash);
    return found.state === "attested" && found.forwardHash !== null && isForwardDelivered(found.forwardState);
  }

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ASSETS_QUERY_KEY });
  }

  // One run per ID at a time, so a second click can't send the same thing twice. A failure is
  // kept for the page to show, next to a way to resume, and thrown to the caller.
  async function runExclusive(
    id: string,
    setRunning: React.Dispatch<React.SetStateAction<string[]>>,
    run: () => Promise<void>,
  ) {
    if (running.current.has(id)) throw new Error("This is already in progress");
    running.current.add(id);
    setRunning((current) => [...current, id]);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await run();
    } catch (error) {
      setFailures((current) => ({ ...current, [id]: describeError(error) }));
      throw error;
    } finally {
      running.current.delete(id);
      setRunning((current) => current.filter((runningId) => runningId !== id));
      await refresh();
    }
  }

  // Runs in the background. A run already going is left alone.
  async function runInBackground(
    id: string,
    setRunning: React.Dispatch<React.SetStateAction<string[]>>,
    run: () => Promise<void>,
  ) {
    if (running.current.has(id)) return;
    try {
      await runExclusive(id, setRunning, run);
    } catch (error) {
      // The page shows it from failures. The full error is kept here for debugging.
      console.error(error);
    }
  }

  function runSetup(assetId: string, chain: Chain) {
    // The buttons wait while one runs. This holds if two clicks land before the page re-renders.
    if (isAnySetupRunning([...running.current], assetId)) return;
    void runInBackground(setupKey(assetId, chain.id), setRunningSetups, () =>
      continueSetup(assetId, chain, wagmiConfig, {
        fetchAsset: fetchSavedAsset,
        saveSent: async (id, chainId, step, transactionHash) => {
          await saveSentSetupStep(id, chainId, step, transactionHash);
          await refresh();
        },
        saveProgress: async (id, chainId, step, state, transactionHash, tokenAddress) => {
          await saveSetupStepProgress(id, chainId, step, state, transactionHash, tokenAddress);
          await refresh();
        },
        findUnsaved: findUnsavedStep,
        rememberUnsaved: rememberUnsavedStep,
        forgetUnsaved: forgetUnsavedStep,
      }),
    );
  }

  function mintRecords(order: MintOrder): MintRecords {
    return {
      fetchSaved: () => fetchMint(order.id),
      saveSent: async (transactionHash) => {
        await saveSentMint({ ...order, transactionHash });
        await refresh();
      },
      saveProgress: async (state, transactionHash) => {
        await saveMintProgress(order.id, state, transactionHash);
        await refresh();
      },
    };
  }

  function unsavedMintSlot(order: MintOrder, issuer: Address): UnsavedMintSlot {
    return {
      read: () => findUnsavedMint(order.id),
      write: (transactionHash) => rememberUnsavedMint({ ...order, issuer, transactionHash }),
      clear: () => forgetUnsavedMint(order.id),
    };
  }

  function transferRecords(order: TransferOrder): TransferRecords {
    return {
      fetchSaved: () => fetchTransfer(order.id),
      fetchSenderTransfers: () => fetchSenderTransfers(order.assetId, order.sender),
      // Saved just before the burn, under a quote that expires in about two minutes. Waiting for
      // every chain to be read again would spend that window, so the page catches up in the
      // background; runExclusive still waits for a refresh when the run ends.
      saveNew: async (crossChainFee) => {
        await saveNewTransfer({ ...order, crossChainFee });
        void refresh();
      },
      saveFee: async (crossChainFee) => {
        await saveTransferFee(order.id, crossChainFee);
        void refresh();
      },
      saveSubmitted: async (sourceTransactionHash) => {
        await saveTransferProgress(order.id, { state: "source-submitted", sourceTransactionHash });
        await refresh();
      },
      unsaved: {
        read: () => findUnsavedTransfer(order.id),
        write: (held) => rememberUnsavedTransfer(order.id, held),
        clear: () => forgetUnsavedTransfer(order.id),
      },
    };
  }

  function deliveryRecords(transfer: TransferActivity): DeliveryRecords {
    return {
      saveProgress: async (progress) => {
        await saveTransferProgress(transfer.id, progress);
        await refresh();
      },
      fetchSenderTransfers: () => fetchSenderTransfers(transfer.assetId, transfer.sender),
      unsaved: {
        read: () => findUnsavedDelivery(transfer.id),
        write: (transactionHash) => rememberUnsavedDelivery(transfer.id, transactionHash),
        clear: () => forgetUnsavedDelivery(transfer.id),
      },
    };
  }

  async function fetchAsset(assetId: string) {
    const asset = await fetchSavedAsset(assetId);
    if (!asset) throw new Error(`Asset ${assetId} wasn't found`);
    return asset;
  }

  // Sends the transfer's burn once. A row already saved is searched for a burn before anything
  // is sent again, so a resumed transfer can't burn twice.
  async function runTransfer(order: TransferOrder) {
    await sendTransfer(order, await fetchAsset(order.assetId), wagmiConfig, iris, transferRecords(order));
  }

  // Tracks the saved burn to delivery. Read fresh, so a stale row on the page can't pick the step.
  async function runDelivery(transferId: string, assetId: string) {
    const saved = await fetchTransfer(transferId);
    if (!saved) throw new Error(`Transfer ${transferId} wasn't found`);
    await advanceTransfer(saved, await fetchAsset(assetId), wagmiConfig, iris, deliveryRecords(saved));
  }

  function continueTransfer(transfer: TransferActivity) {
    void runInBackground(transfer.id, setRunningTransfers, async () => {
      if (transfer.state === "approval-required") await runTransfer(transfer);
      await runDelivery(transfer.id, transfer.assetId);
    });
  }

  const store: AssetStore = {
    runningSetups,
    runningMints,
    runningTransfers,
    failures,
    launchAsset: async (asset) => {
      const crossChainId = await computeCrossChainId(
        publicFor(wagmiConfig, ARC_TESTNET),
        asset.issuer,
        asset.salt,
      );
      await saveNewAsset({ ...asset, crossChainId });
      await refresh();
      runSetup(asset.id, ARC_TESTNET);
    },
    resumeSetup: (asset, chain) => runSetup(asset.id, chain),
    enableNetwork: (asset, chain) => runSetup(asset.id, chain),
    mint: (order) => {
      if (!address) throw new Error("Sign in with the issuer wallet to mint");
      return mintOnce(
        unsavedMintSlot(order, address),
        async () => sendIssuerMint(await fetchAsset(order.assetId), order.recipient, order.amount, wagmiConfig),
        mintRecords(order),
        wagmiConfig,
      );
    },
    finishMint: (mint) =>
      void runInBackground(mint.id, setRunningMints, async () => {
        await finishMint(mint.transactionHash, mintRecords(mint), wagmiConfig);
      }),
    unsavedMintFailure: unsavedMints.error,
    retryUnsavedMints: () => void unsavedMints.refetch(),
    discardUnsavedMint: (mintId) => {
      forgetUnsavedMint(mintId);
      void unsavedMints.refetch();
    },
    quoteTransfer: async (request, sender) =>
      quoteTransfer(
        await fetchAsset(request.assetId),
        { source: findChain(request.sourceChainId), destination: findChain(request.destinationChainId) },
        sender,
        request.recipient,
        request.amount,
        wagmiConfig,
        iris,
      ),
    startTransfer: async (request, sender) => {
      await runExclusive(request.id, setRunningTransfers, () => runTransfer({ ...request, sender }));
      void runInBackground(request.id, setRunningTransfers, () => runDelivery(request.id, request.assetId));
    },
    continueTransfer,
    findForwarding: async (transfer) => {
      if (!transfer.sourceTransactionHash) return null;
      const route = { source: findChain(transfer.sourceChainId), destination: findChain(transfer.destinationChainId) };
      const found = await iris.findMessage(route, transfer.sourceTransactionHash);
      return found.state === "attested" ? isForwarding(found) : null;
    },
  };

  return <AssetStoreContext value={store}>{children}</AssetStoreContext>;
}

export function useAssetStore() {
  const store = useContext(AssetStoreContext);
  if (!store) throw new Error("useAssetStore must be used inside AssetStoreProvider");
  return store;
}
