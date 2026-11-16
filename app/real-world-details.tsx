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

import { InfoCircle } from "iconoir-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import type { RealWorldDetails } from "@/lib/assets";
import { DetailList, DetailRow } from "./details";

export function DemoInformationAlert() {
  return (
    <Alert>
      <InfoCircle />
      <AlertTitle>Demo information</AlertTitle>
      <AlertDescription>
        Backing and documents for real-world assets are simulated. Nothing here is verified.
      </AlertDescription>
    </Alert>
  );
}

export function RealWorldDetailsList({ details }: { details: RealWorldDetails }) {
  return (
    <div className="flex flex-col gap-4">
      <DemoInformationAlert />
      <DetailList>
        <DetailRow label="Issuer name">{details.issuerName}</DetailRow>
        <DetailRow label="Asset category">{details.category}</DetailRow>
        <DetailRow label="Underlying asset">{details.underlyingDescription}</DetailRow>
        <DetailRow label="Supporting document">
          {details.documentUrl ? (
            <a
              href={details.documentUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "link", size: "xs" }),
                "h-auto px-0 break-all whitespace-normal",
              )}
            >
              {details.documentUrl}
            </a>
          ) : (
            "None"
          )}
        </DetailRow>
      </DetailList>
    </div>
  );
}
