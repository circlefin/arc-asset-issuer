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

import { describe, expect, it } from "vitest";
import { readableText, storageSnapshot, storedField } from "./stored";

describe("storedField", () => {
  it("reads an entry's own field, and nothing from what isn't an object", () => {
    expect(storedField({ transferId: "a" }, "transferId")).toBe("a");
    expect(storedField({}, "constructor")).toBeUndefined();
    expect(storedField(null, "transferId")).toBeUndefined();
    expect(storedField("text", "length")).toBeUndefined();
  });
});

describe("storageSnapshot", () => {
  it("returns the stored text", () => {
    expect(storageSnapshot(() => "[]")()).toBe("[]");
    expect(storageSnapshot(() => null)()).toBeNull();
  });

  it("returns a refused read as unreadable, the same object while it lasts, never as nothing stored", () => {
    const error = new DOMException("The operation is insecure.", "SecurityError");
    let blocked = true;
    const snapshot = storageSnapshot(() => {
      if (blocked) throw error;
      return "[]";
    });
    const first = snapshot();
    expect(first).toEqual({ unreadable: error });
    expect(snapshot()).toBe(first);
    blocked = false;
    expect(snapshot()).toBe("[]");
  });
});

describe("readableText", () => {
  it("passes text through and throws a refusal again", () => {
    expect(readableText("[]")).toBe("[]");
    expect(readableText(null)).toBeNull();
    const error = new Error("blocked");
    expect(() => readableText({ unreadable: error })).toThrow(error);
  });
});
