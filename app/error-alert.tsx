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

import { WarningTriangle } from "iconoir-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeError } from "@/lib/format";

// Why an action failed, shown where it was tried, so it can be tried again.
export function ErrorAlert({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>That didn&apos;t work</AlertTitle>
      <AlertDescription>{describeError(error)}</AlertDescription>
    </Alert>
  );
}

// An asset whose supply and balances couldn't be read, shown where they would be, with why.
export function HoldingsUnreadAlert({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive">
      <WarningTriangle />
      <AlertTitle>Balances can&apos;t be shown</AlertTitle>
      <AlertDescription>{describeError(error)}</AlertDescription>
    </Alert>
  );
}
