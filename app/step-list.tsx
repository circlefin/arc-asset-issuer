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

import { CheckCircle, Circle, WarningTriangle } from "iconoir-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

export type StepStatus = "done" | "active" | "pending" | "failed";

export type Step = {
  label: string;
  description?: string;
  status: StepStatus;
  // Set on the right, such as the step's transaction.
  action?: React.ReactNode;
};

const STATUS_ICONS = {
  done: <CheckCircle className="text-success" />,
  active: <Spinner />,
  pending: <Circle className="text-muted-foreground" />,
  failed: <WarningTriangle className="text-destructive" />,
} satisfies Record<StepStatus, React.ReactNode>;

// One row per transaction or state, so progress reads top to bottom.
export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ItemGroup>
      {steps.map((step, index) => (
        <Item key={index} size="xs" className="px-0">
          <ItemMedia variant="icon">{STATUS_ICONS[step.status]}</ItemMedia>
          <ItemContent>
            <ItemTitle
              className={step.status === "pending" ? "text-muted-foreground" : undefined}
            >
              {step.label}
            </ItemTitle>
            {step.description && (
              <ItemDescription>{step.description}</ItemDescription>
            )}
          </ItemContent>
          {step.action && <ItemActions>{step.action}</ItemActions>}
        </Item>
      ))}
    </ItemGroup>
  );
}

// Steps before the current one are done, the current one is running, the rest wait.
export function statusAt(index: number, current: number, running: boolean): StepStatus {
  if (index < current) return "done";
  if (index === current && running) return "active";
  return "pending";
}
