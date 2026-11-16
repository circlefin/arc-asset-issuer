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

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type AssetAvatarProps = {
  imageUrl: string | null;
  symbol: string;
  className?: string;
};

export function AssetAvatar({ imageUrl, symbol, className }: AssetAvatarProps) {
  return (
    <Avatar className={className}>
      {imageUrl && <AvatarImage src={imageUrl} alt="" />}
      <AvatarFallback className="kicker">{symbol.slice(0, 2)}</AvatarFallback>
    </Avatar>
  );
}
