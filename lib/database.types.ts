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


export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "assets": {
                  Row: {
                    "category": Database["public"]['Enums']["rwa_category"] | null,"created_at": string,"cross_chain_id": string,"decimals": number,"description": string,"document_url": string | null,"id": string,"issuer": string,"issuer_name": string | null,"name": string,"salt": string,"symbol": string,"type": Database["public"]['Enums']["asset_type"],"underlying_description": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "category"?: Database["public"]['Enums']["rwa_category"] | null,"created_at"?: string,"cross_chain_id": string,"decimals": number,"description": string,"document_url"?: string | null,"id": string,"issuer": string,"issuer_name"?: string | null,"name": string,"salt": string,"symbol": string,"type": Database["public"]['Enums']["asset_type"],"underlying_description"?: string | null
                  }
                  Update: {
                    "category"?: Database["public"]['Enums']["rwa_category"] | null,"created_at"?: string,"cross_chain_id"?: string,"decimals"?: number,"description"?: string,"document_url"?: string | null,"id"?: string,"issuer"?: string,"issuer_name"?: string | null,"name"?: string,"salt"?: string,"symbol"?: string,"type"?: Database["public"]['Enums']["asset_type"],"underlying_description"?: string | null
                  }
                  Relationships: [

                  ]
                },"issuer_mints": {
                  Row: {
                    "amount": number,"asset_id": string,"created_at": string,"id": string,"recipient": string,"state": Database["public"]['Enums']["mint_state"],"transaction_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"asset_id": string,"created_at"?: string,"id": string,"recipient": string,"state"?: Database["public"]['Enums']["mint_state"],"transaction_hash": string
                  }
                  Update: {
                    "amount"?: number,"asset_id"?: string,"created_at"?: string,"id"?: string,"recipient"?: string,"state"?: Database["public"]['Enums']["mint_state"],"transaction_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "issuer_mints_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id"]
    }
                  ]
                },"setup_transactions": {
                  Row: {
                    "asset_id": string,"chain": Database["public"]['Enums']["chain"],"created_at": string,"state": Database["public"]['Enums']["setup_step_state"],"step": number,"token_address": string | null,"transaction_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_id": string,"chain": Database["public"]['Enums']["chain"],"created_at"?: string,"state"?: Database["public"]['Enums']["setup_step_state"],"step": number,"token_address"?: string | null,"transaction_hash": string
                  }
                  Update: {
                    "asset_id"?: string,"chain"?: Database["public"]['Enums']["chain"],"created_at"?: string,"state"?: Database["public"]['Enums']["setup_step_state"],"step"?: number,"token_address"?: string | null,"transaction_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "setup_transactions_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id"]
    }
                  ]
                },"transfers": {
                  Row: {
                    "amount": number,"asset_id": string,"created_at": string,"cross_chain_fee": number,"destination_chain": Database["public"]['Enums']["chain"],"destination_transaction_hash": string | null,"id": string,"recipient": string,"sender": string,"source_chain": Database["public"]['Enums']["chain"],"source_transaction_hash": string | null,"state": Database["public"]['Enums']["transfer_state"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"asset_id": string,"created_at"?: string,"cross_chain_fee": number,"destination_chain": Database["public"]['Enums']["chain"],"destination_transaction_hash"?: string | null,"id": string,"recipient": string,"sender": string,"source_chain": Database["public"]['Enums']["chain"],"source_transaction_hash"?: string | null,"state"?: Database["public"]['Enums']["transfer_state"],"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"asset_id"?: string,"created_at"?: string,"cross_chain_fee"?: number,"destination_chain"?: Database["public"]['Enums']["chain"],"destination_transaction_hash"?: string | null,"id"?: string,"recipient"?: string,"sender"?: string,"source_chain"?: Database["public"]['Enums']["chain"],"source_transaction_hash"?: string | null,"state"?: Database["public"]['Enums']["transfer_state"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transfers_asset_id_fkey"
      columns: ["asset_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "in_flight_transfer_totals":
{ Args: { "asset_ids": (string)[] }; Returns: {
              "amount": string,"asset_id": string
            }[]
                           },
"record_issuer_mint":
{ Args: { "amount": string,"asset_id": string,"id": string,"recipient": string,"transaction_hash": string }; Returns: undefined
                           },
"save_transfer_fee":
{ Args: { "cross_chain_fee": string,"id": string }; Returns: undefined
                           },
"start_transfer":
{ Args: { "amount": string,"asset_id": string,"cross_chain_fee": string,"destination_chain": Database["public"]['Enums']["chain"],"id": string,"recipient": string,"sender": string,"source_chain": Database["public"]['Enums']["chain"] }; Returns: undefined
                           }
          }
          Enums: {
            "asset_type": "community"|"real-world","chain": "arc-testnet"|"base-sepolia"|"ethereum-sepolia"|"avalanche-fuji"|"op-sepolia"|"arbitrum-sepolia"|"polygon-amoy","mint_state": "pending"|"confirmed"|"reverted","rwa_category": "Treasury bills"|"Real estate"|"Commodities"|"Private credit","setup_step_state": "pending"|"confirmed"|"reverted","transfer_state": "approval-required"|"source-submitted"|"awaiting-attestation"|"delivering"|"delivery-failed"|"complete"|"burn-failed"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {

          }
        },"public": {
          Enums: {
            "asset_type": ["community", "real-world"],"chain": ["arc-testnet", "base-sepolia", "ethereum-sepolia", "avalanche-fuji", "op-sepolia", "arbitrum-sepolia", "polygon-amoy"],"mint_state": ["pending", "confirmed", "reverted"],"rwa_category": ["Treasury bills", "Real estate", "Commodities", "Private credit"],"setup_step_state": ["pending", "confirmed", "reverted"],"transfer_state": ["approval-required", "source-submitted", "awaiting-attestation", "delivering", "delivery-failed", "complete", "burn-failed"]
          }
        }
} as const
