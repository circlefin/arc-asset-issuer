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

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, MediaImage, Rocket, Upload } from "iconoir-react";
import Link from "next/link";
import { useRef, useState } from "react";
import type { Address } from "viem";
import { useConfig } from "wagmi";
import { Button, buttonVariants } from "@/components/ui/button";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  ASSET_TYPE_LABELS,
  DEFAULT_DECIMALS,
  IMAGE_TYPES,
  isSetupComplete,
  MAX_DECIMALS,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MEGABYTES,
  MAX_NAME_LENGTH,
  MAX_SYMBOL_LENGTH,
  RWA_CATEGORIES,
  setupStepsOn,
  type AssetConfig,
  type AssetType,
  type RwaCategory,
} from "@/lib/assets";
import { newSalt } from "@/lib/cctp/encoding";
import { estimateSetupCost } from "@/lib/cctp/setup";
import { ARC_TESTNET } from "@/lib/chains";
import { formatTokenAmount, shortenHex } from "@/lib/format";
import { AssetAvatar } from "./asset-avatar";
import { AssetContracts } from "./asset-contracts";
import { useAssetStore } from "./asset-store";
import { DetailList, DetailRow } from "./details";
import { ErrorAlert } from "./error-alert";
import { LoadingSkeleton } from "./loading-skeleton";
import { MintingPermissions } from "./minting-permissions";
import { MintDialog } from "./mint-dialog";
import { assetPath } from "./nav-items";
import { DemoInformationAlert, RealWorldDetailsList } from "./real-world-details";
import { SetupProgress } from "./setup-progress";
import { ConnectWalletButton } from "./connect-wallet";
import { CopyButton } from "./copy-button";
import { useAsset } from "./use-asset";
import { useWallet } from "./wallet";

const ASSET_TYPE_DESCRIPTIONS: Record<AssetType, string> = {
  community: "A meme coin or any token for a community.",
  "real-world": "A token that stands for something off-chain, like a bond or a building.",
};

const ASSET_TYPES: AssetType[] = ["community", "real-world"];

// Uppercase letters and digits only, like most tickers.
const SYMBOL_PATTERN = new RegExp(`^[A-Z0-9]{1,${MAX_SYMBOL_LENGTH}}$`);
const WHOLE_NUMBER_PATTERN = /^\d+$/;
const WEB_PROTOCOLS = ["http:", "https:"];

// The chosen file, and a local URL to preview it before it's uploaded.
type DraftImage = { file: File; previewUrl: string };

type Step =
  | { name: "configure" }
  | { name: "review"; config: AssetConfig; image: DraftImage }
  | { name: "launched"; assetId: string };

const CONFIGURE_STEP: Step = { name: "configure" };

const CONFIGURE_FORM_ID = "create-asset-form";

type Draft = {
  type: AssetType;
  name: string;
  symbol: string;
  description: string;
  image: DraftImage | null;
  decimals: string;
  issuerName: string;
  category: RwaCategory;
  underlyingDescription: string;
  documentUrl: string;
};

const EMPTY_DRAFT: Draft = {
  type: "community",
  name: "",
  symbol: "",
  description: "",
  image: null,
  decimals: String(DEFAULT_DECIMALS),
  issuerName: "",
  category: RWA_CATEGORIES[0],
  underlyingDescription: "",
  documentUrl: "",
};

type DraftErrors = Partial<Record<keyof Draft, string>>;

// Only web links, so a document link can't run script.
function isWebUrl(value: string) {
  return URL.canParse(value) && WEB_PROTOCOLS.includes(new URL(value).protocol);
}

function isFilledWithin(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

function validateTokenDetails(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (!isFilledWithin(draft.name, MAX_NAME_LENGTH)) {
    errors.name = `Enter a name, up to ${MAX_NAME_LENGTH} characters.`;
  }
  if (!SYMBOL_PATTERN.test(draft.symbol)) {
    errors.symbol = `Use up to ${MAX_SYMBOL_LENGTH} capital letters or digits.`;
  }
  if (!isFilledWithin(draft.description, MAX_DESCRIPTION_LENGTH)) {
    errors.description = `Enter a description, up to ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (!draft.image) {
    errors.image = "Choose an image.";
  } else if (!IMAGE_TYPES.includes(draft.image.file.type)) {
    errors.image = "Use a PNG, JPEG, GIF or WebP image.";
  } else if (draft.image.file.size > MAX_IMAGE_BYTES) {
    errors.image = `Use an image up to ${MAX_IMAGE_MEGABYTES} MB.`;
  }
  if (!WHOLE_NUMBER_PATTERN.test(draft.decimals) || Number(draft.decimals) > MAX_DECIMALS) {
    errors.decimals = `Enter a whole number from 0 to ${MAX_DECIMALS}.`;
  }
  return errors;
}

function validateRealWorldDetails(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.issuerName.trim()) errors.issuerName = "Enter the issuer's name.";
  if (!draft.underlyingDescription.trim()) {
    errors.underlyingDescription = "Describe what the token stands for.";
  }
  const documentUrl = draft.documentUrl.trim();
  if (documentUrl && !isWebUrl(documentUrl)) {
    errors.documentUrl = "Enter a link starting with http:// or https://.";
  }
  return errors;
}

function validateDraft(draft: Draft): DraftErrors {
  if (draft.type === "community") return validateTokenDetails(draft);
  return { ...validateTokenDetails(draft), ...validateRealWorldDetails(draft) };
}

function toConfig(draft: Draft): AssetConfig {
  const details = {
    name: draft.name.trim(),
    symbol: draft.symbol,
    description: draft.description.trim(),
    decimals: Number(draft.decimals),
  };
  if (draft.type === "community") return { ...details, type: "community" };
  return {
    ...details,
    type: "real-world",
    realWorld: {
      issuerName: draft.issuerName.trim(),
      category: draft.category,
      underlyingDescription: draft.underlyingDescription.trim(),
      documentUrl: draft.documentUrl.trim() || null,
    },
  };
}

type CreateAssetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Closing keeps the draft, so a stray click outside loses nothing. After a launch, the next one starts fresh.
export function CreateAssetDialog({ open, onOpenChange }: CreateAssetDialogProps) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [step, setStep] = useState(CONFIGURE_STEP);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen && step.name === "launched") setStep(CONFIGURE_STEP);
      }}
    >
      <DialogContent>
        {step.name === "launched" && <LaunchProgress assetId={step.assetId} />}
        {step.name === "review" && (
          <Review
            config={step.config}
            image={step.image}
            onBack={() => setStep(CONFIGURE_STEP)}
            onLaunched={(assetId) => {
              setDraft(EMPTY_DRAFT);
              setStep({ name: "launched", assetId });
            }}
          />
        )}
        {step.name === "configure" && (
          <Configure
            draft={draft}
            onChange={(change) => setDraft((current) => ({ ...current, ...change }))}
            onReview={(config, image) => setStep({ name: "review", config, image })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type SectionProps = {
  title: string;
  children: React.ReactNode;
};

function Section({ title, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="font-heading text-base leading-subhead">{title}</h3>
      {children}
    </section>
  );
}

type ConfigureProps = {
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
  onReview: (config: AssetConfig, image: DraftImage) => void;
};

function Configure({ draft, onChange, onReview }: ConfigureProps) {
  const { address } = useWallet();
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateDraft(draft);
  const errorFor = (field: keyof Draft) => (showErrors ? errors[field] : undefined);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create asset</DialogTitle>
        <DialogDescription>
          Choose carefully. These details can&apos;t be changed once the asset is launched.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form
          id={CONFIGURE_FORM_ID}
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (Object.keys(errors).length > 0 || !draft.image) {
              setShowErrors(true);
              return;
            }
            onReview(toConfig(draft), draft.image);
          }}
        >
          <FieldSet>
            <FieldLegend>Asset type</FieldLegend>
            <RadioGroup
              value={draft.type}
              onValueChange={(value) => {
                const type = ASSET_TYPES.find((option) => option === value);
                if (type) onChange({ type });
              }}
              className="grid gap-3 sm:grid-cols-2"
            >
              {ASSET_TYPES.map((type) => (
                <FieldLabel key={type} htmlFor={type}>
                  <Field orientation="horizontal">
                    <RadioGroupItem id={type} value={type} />
                    <FieldContent>
                      <FieldTitle>{ASSET_TYPE_LABELS[type]}</FieldTitle>
                      <FieldDescription>{ASSET_TYPE_DESCRIPTIONS[type]}</FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend>Token details</FieldLegend>
            <FieldGroup>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field data-invalid={Boolean(errorFor("name"))}>
                  <FieldLabel htmlFor="name">Name</FieldLabel>
                  <Input
                    id="name"
                    placeholder="Name your token"
                    maxLength={MAX_NAME_LENGTH}
                    value={draft.name}
                    aria-invalid={Boolean(errorFor("name"))}
                    onChange={(event) => onChange({ name: event.target.value })}
                  />
                  <FieldError>{errorFor("name")}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errorFor("symbol"))}>
                  <FieldLabel htmlFor="symbol">Symbol</FieldLabel>
                  <Input
                    id="symbol"
                    placeholder="e.g. DOGE"
                    maxLength={MAX_SYMBOL_LENGTH}
                    value={draft.symbol}
                    aria-invalid={Boolean(errorFor("symbol"))}
                    onChange={(event) =>
                      onChange({ symbol: event.target.value.toUpperCase() })
                    }
                  />
                  <FieldError>{errorFor("symbol")}</FieldError>
                </Field>
              </div>
              <Field data-invalid={Boolean(errorFor("description"))}>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Textarea
                  id="description"
                  placeholder="Write a short description"
                  maxLength={MAX_DESCRIPTION_LENGTH}
                  value={draft.description}
                  aria-invalid={Boolean(errorFor("description"))}
                  onChange={(event) => onChange({ description: event.target.value })}
                />
                <FieldError>{errorFor("description")}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errorFor("decimals"))}>
                <FieldLabel htmlFor="decimals">Decimals</FieldLabel>
                <Input
                  id="decimals"
                  type="number"
                  min={0}
                  max={MAX_DECIMALS}
                  step={1}
                  value={draft.decimals}
                  aria-invalid={Boolean(errorFor("decimals"))}
                  onChange={(event) => onChange({ decimals: event.target.value })}
                />
                <FieldDescription>The same on every chain.</FieldDescription>
                <FieldError>{errorFor("decimals")}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errorFor("image"))}>
                <FieldLabel htmlFor="image">Image</FieldLabel>
                <ImageDropArea
                  image={draft.image}
                  symbol={draft.symbol}
                  invalid={Boolean(errorFor("image"))}
                  onChoose={(file) => {
                    if (draft.image) URL.revokeObjectURL(draft.image.previewUrl);
                    onChange({ image: { file, previewUrl: URL.createObjectURL(file) } });
                  }}
                />
                <FieldError>{errorFor("image")}</FieldError>
              </Field>
            </FieldGroup>
          </FieldSet>

          {draft.type === "real-world" && (
            <RealWorldFields draft={draft} errorFor={errorFor} onChange={onChange} />
          )}
        </form>
      </DialogBody>
      <DialogFooter>
        {address ? (
          <Button type="submit" form={CONFIGURE_FORM_ID}>
            Review
          </Button>
        ) : (
          <ConnectWalletButton />
        )}
      </DialogFooter>
    </>
  );
}

type ImageDropAreaProps = {
  image: DraftImage | null;
  symbol: string;
  invalid: boolean;
  onChoose: (file: File) => void;
};

function ImageDropArea({ image, symbol, invalid, onChoose }: ImageDropAreaProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const chooseFirst = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onChoose(file);
  };

  return (
    <Item
      variant="outline"
      data-dragging={dragging}
      data-invalid={invalid}
      className="border-dashed data-[dragging=true]:border-primary data-[dragging=true]:bg-muted data-[invalid=true]:border-destructive"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Moving onto a child also fires a leave. Only leaving the area counts.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
          return;
        }
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        chooseFirst(event.dataTransfer.files);
      }}
    >
      {image ? (
        <ItemMedia>
          <AssetAvatar imageUrl={image.previewUrl} symbol={symbol} />
        </ItemMedia>
      ) : (
        <ItemMedia variant="icon">
          <MediaImage />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>Select an image to upload</ItemTitle>
        <ItemDescription>or drag and drop it here</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
          <Upload data-icon="inline-start" />
          {image ? "Replace" : "Upload"}
        </Button>
        {/* The button opens it, so it skips the tab order. */}
        <Input
          id="image"
          ref={input}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          tabIndex={-1}
          className="sr-only"
          aria-invalid={invalid}
          onChange={(event) => chooseFirst(event.target.files)}
        />
      </ItemActions>
    </Item>
  );
}

type RealWorldFieldsProps = {
  draft: Draft;
  errorFor: (field: keyof Draft) => string | undefined;
  onChange: (change: Partial<Draft>) => void;
};

function RealWorldFields({ draft, errorFor, onChange }: RealWorldFieldsProps) {
  return (
    <FieldSet>
      <FieldLegend className="mb-4">Real-world asset</FieldLegend>
      <DemoInformationAlert />
      <FieldGroup>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field data-invalid={Boolean(errorFor("issuerName"))}>
            <FieldLabel htmlFor="issuer-name">Issuer name</FieldLabel>
            <Input
              id="issuer-name"
              value={draft.issuerName}
              aria-invalid={Boolean(errorFor("issuerName"))}
              onChange={(event) => onChange({ issuerName: event.target.value })}
            />
            <FieldError>{errorFor("issuerName")}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="category">Asset category</FieldLabel>
            <Select
              value={draft.category}
              onValueChange={(value) => {
                const category = RWA_CATEGORIES.find((option) => option === value);
                if (category) onChange({ category });
              }}
            >
              <SelectTrigger id="category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {RWA_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field data-invalid={Boolean(errorFor("underlyingDescription"))}>
          <FieldLabel htmlFor="underlying">Underlying asset</FieldLabel>
          <Textarea
            id="underlying"
            placeholder="What the token stands for"
            value={draft.underlyingDescription}
            aria-invalid={Boolean(errorFor("underlyingDescription"))}
            onChange={(event) =>
              onChange({ underlyingDescription: event.target.value })
            }
          />
          <FieldError>{errorFor("underlyingDescription")}</FieldError>
        </Field>
        <Field data-invalid={Boolean(errorFor("documentUrl"))}>
          <FieldLabel htmlFor="document">
            Supporting document link
            <span className="text-muted-foreground">(Optional)</span>
          </FieldLabel>
          <Input
            id="document"
            type="url"
            placeholder="https://"
            value={draft.documentUrl}
            aria-invalid={Boolean(errorFor("documentUrl"))}
            onChange={(event) => onChange({ documentUrl: event.target.value })}
          />
          <FieldError>{errorFor("documentUrl")}</FieldError>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

type ReviewProps = {
  config: AssetConfig;
  image: DraftImage;
  onBack: () => void;
  onLaunched: (assetId: string) => void;
};

function Review({ config, image, onBack, onLaunched }: ReviewProps) {
  const { address } = useWallet();
  const { launchAsset } = useAssetStore();
  // Made once per review, so retrying a failed launch can't create a second asset.
  const [assetId] = useState(() => crypto.randomUUID());
  // Kept with the asset ID, so a retried launch registers under the same cross-chain ID.
  const [salt] = useState(newSalt);
  const launching = useMutation({
    mutationFn: (issuer: Address) =>
      launchAsset({ id: assetId, issuer, config, image: image.file, salt }),
    onSuccess: () => onLaunched(assetId),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Review</DialogTitle>
        <DialogDescription>Check everything before you launch.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Section title="Token">
          <DetailList>
            <DetailRow label="Type">{ASSET_TYPE_LABELS[config.type]}</DetailRow>
            <DetailRow label="Image">
              <AssetAvatar imageUrl={image.previewUrl} symbol={config.symbol} />
            </DetailRow>
            <DetailRow label="Name">{config.name}</DetailRow>
            <DetailRow label="Symbol">{config.symbol}</DetailRow>
            <DetailRow label="Description">{config.description}</DetailRow>
            <DetailRow label="Decimals">{config.decimals}</DetailRow>
            <DetailRow label="Starting supply">0</DetailRow>
            {address && (
              <DetailRow label="Issuer wallet">
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono">{shortenHex(address)}</span>
                  <CopyButton value={address} label="Copy address" />
                </span>
              </DetailRow>
            )}
          </DetailList>
        </Section>
        {address && (
          <>
            <Separator />
            <Section title="Minting permissions">
              {/* Launched on Arc only; other networks are enabled later. */}
              <MintingPermissions issuer={address} networks={[]} />
            </Section>
          </>
        )}
        <Separator />
        <Section title="Enabled networks and estimated costs">
          {address ? (
            <EstimatedCosts issuer={address} config={config} />
          ) : (
            <p className="text-sm text-muted-foreground">Connect a wallet to estimate costs.</p>
          )}
        </Section>
        {config.type === "real-world" && (
          <>
            <Separator />
            <Section title="Real-world asset">
              <RealWorldDetailsList details={config.realWorld} />
            </Section>
          </>
        )}
        {launching.error && <ErrorAlert error={launching.error} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={launching.isPending} onClick={onBack}>
          <ArrowLeft data-icon="inline-start" />
          Edit
        </Button>
        {address ? (
          <Button disabled={launching.isPending} onClick={() => launching.mutate(address)}>
            {launching.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Rocket data-icon="inline-start" />
            )}
            Launch asset
          </Button>
        ) : (
          <ConnectWalletButton />
        )}
      </DialogFooter>
    </>
  );
}

// One transaction per setup step, paid in Arc's gas token. A launch sets up Arc only.
function EstimatedCosts({ issuer, config }: { issuer: Address; config: AssetConfig }) {
  const wagmiConfig = useConfig();
  const chain = ARC_TESTNET;
  const costs = useQuery({
    queryKey: ["setup-cost", issuer, chain.id, config],
    queryFn: () => estimateSetupCost(issuer, config, chain, wagmiConfig),
    // Shown inline, so a failed estimate doesn't replace the page and lose the form.
    throwOnError: false,
  });
  if (costs.error) return <ErrorAlert error={costs.error} />;
  const cost = costs.data;
  return (
    <DetailList>
      <DetailRow label={`${chain.name}, ${setupStepsOn(chain).length} transactions`}>
        {cost === undefined ? (
          <Spinner />
        ) : (
          `~${formatTokenAmount(cost, chain.gasDecimals)} ${chain.gasSymbol}`
        )}
      </DetailRow>
    </DetailList>
  );
}

function LaunchProgress({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId);
  const [minting, setMinting] = useState(false);
  if (!asset) return <LoadingSkeleton />;
  const complete = isSetupComplete(asset);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{complete ? `${asset.symbol} is live` : `Launching ${asset.symbol}`}</DialogTitle>
        <DialogDescription>
          {complete
            ? "Setup is done. Supply starts at zero until you mint."
            : "Sign each transaction. If setup stops, you can resume it from the asset page."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Section title="Setup">
          <SetupProgress asset={asset} chain={ARC_TESTNET} />
        </Section>
        {complete && (
          <>
            <Separator />
            <Section title="Contracts">
              <AssetContracts asset={asset} />
            </Section>
          </>
        )}
      </DialogBody>
      {complete && (
        <DialogFooter>
          <Link href={assetPath(asset.id)} className={buttonVariants({ variant: "outline" })}>
            View asset
          </Link>
          <Button onClick={() => setMinting(true)}>Mint tokens</Button>
          <MintDialog asset={asset} open={minting} onOpenChange={setMinting} />
        </DialogFooter>
      )}
    </>
  );
}
