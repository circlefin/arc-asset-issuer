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

// Reading what this browser keeps in localStorage.

// One field of a parsed entry, or undefined. Own fields only, so a key like "constructor" can't
// read something the entry never stored.
export function storedField(entry: unknown, key: string): unknown {
  return typeof entry === "object" && entry !== null ? Object.getOwnPropertyDescriptor(entry, key)?.value : undefined;
}

// Storage the browser refused to read, such as a SecurityError when site data is blocked.
export type UnreadableStorage = { unreadable: unknown };
export type StoredText = string | null | UnreadableStorage;

// Reads stored text for a page to watch. A refused read is returned, not thrown, so it can't crash
// the render, and it's the same object while the refusal lasts, so React doesn't re-render forever.
// Never null, so a refused read can't look like nothing stored.
export function storageSnapshot(read: () => string | null): () => StoredText {
  let refused: UnreadableStorage | null = null;
  return () => {
    try {
      const text = read();
      refused = null;
      return text;
    } catch (error) {
      refused ??= { unreadable: error };
      return refused;
    }
  };
}

// The stored text, or the refusal thrown again, for a reader that treats any throw as unreadable.
export function readableText(stored: StoredText): string | null {
  if (stored !== null && typeof stored === "object") throw stored.unreadable;
  return stored;
}
