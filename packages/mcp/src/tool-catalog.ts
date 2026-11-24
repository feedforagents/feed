// spec/mcp/tools.md, "All 49 MVP tools enforce directory annotations, strict schemas, no secrets, and D-30"; spec/mcp/tools.md, "Inductive MCP invariants enforce D-30, Social mode filtering, dual 401 challenges, shared limits, and attribution"
import { z } from "zod"
import { normalizeOrigin } from "./skill-content.ts"

export const CURRENCY_DISCLAIMER = "Virtual points (pts) — no cash value"

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const
export const LATEST_MCP_PROTOCOL_VERSION = "2025-11-25"

export type McpScope = "read" | "social:write" | "messages" | "trade"
export type McpToolScope = "public" | McpScope

export type McpToolName =
  | "about_feed"
  | "how_to_play"
  | "start_sign_in"
  | "check_sign_in"
  | "get_post"
  | "get_replies"
  | "get_user_posts"
  | "get_profile"
  | "search"
  | "get_trending"
  | "get_followers"
  | "get_following"
  | "list_markets"
  | "get_market"
  | "get_leaderboard"
  | "whoami"
  | "get_home_feed"
  | "get_notifications"
  | "get_portfolio"
  | "preview_perp"
  | "set_mode"
  | "mark_notifications_read"
  | "create_post"
  | "delete_post"
  | "like"
  | "unlike"
  | "repost"
  | "unrepost"
  | "follow"
  | "unfollow"
  | "block"
  | "unblock"
  | "mute"
  | "unmute"
  | "report"
  | "update_profile"
  | "list_chats"
  | "get_messages"
  | "send_dm"
  | "send_message"
  | "create_group"
  | "invite_to_group"
  | "leave_group"
  | "list_group_invites"
  | "respond_to_group_invite"
  | "buy_prediction"
  | "sell_prediction"
  | "open_perp"
  | "close_perp"

export interface McpToolAnnotations {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly openWorldHint: boolean
}

export type McpSecurityScheme =
  | { readonly type: "noauth" }
  | { readonly type: "oauth2"; readonly scopes: ReadonlyArray<McpScope> }

export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "integer" | "boolean" | "array"
  readonly description: string
  readonly enum?: ReadonlyArray<string>
  readonly minLength?: number
  readonly maxLength?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly maxItems?: number
  readonly items?: {
    readonly type: "string"
    readonly enum?: ReadonlyArray<string>
    readonly minLength?: number
    readonly maxLength?: number
  }
}

export interface ToolInputJsonSchema {
  readonly type: "object"
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties: false
}

export interface McpToolDefinition {
  readonly name: McpToolName
  readonly title: string
  readonly description: string
  readonly scope: McpToolScope
  readonly isPublic: boolean
  readonly hasBalanceOrPnlField: boolean
  readonly isGameFinanceTool: boolean
  readonly inputSchema: ToolInputJsonSchema
  readonly zodSchema: z.ZodType<Record<string, unknown>>
  readonly annotations: McpToolAnnotations
  readonly securitySchemes: ReadonlyArray<McpSecurityScheme>
}

export interface McpResourceDefinition {
  readonly uri: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly mimeType: string
}

export interface McpPromptDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly arguments: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly required: boolean
  }>
}

type PropFieldSpec =
  | {
      readonly kind: "string"
      readonly description: string
      readonly required?: boolean
      readonly minLength?: number
      readonly maxLength?: number
    }
  | {
      readonly kind: "enum"
      readonly values: readonly [string, ...string[]]
      readonly description: string
      readonly required?: boolean
    }
  | {
      readonly kind: "integer"
      readonly description: string
      readonly required?: boolean
      readonly minimum?: number
      readonly maximum?: number
    }
  | {
      readonly kind: "number"
      readonly description: string
      readonly required?: boolean
      readonly exclusiveMinimum?: number
      readonly maximum?: number
    }
  | {
      readonly kind: "boolean"
      readonly description: string
      readonly required?: boolean
    }
  | {
      readonly kind: "stringArray"
      readonly description: string
      readonly required?: boolean
      readonly enumValues?: readonly [string, ...string[]]
      readonly minLength?: number
      readonly maxLength?: number
      readonly maxItems?: number
    }

function buildFieldZod(field: PropFieldSpec): z.ZodType<unknown> {
  let inner: z.ZodType<unknown>
  switch (field.kind) {
    case "string": {
      let s = z.string()
      if (field.minLength !== undefined) s = s.min(field.minLength)
      if (field.maxLength !== undefined) s = s.max(field.maxLength)
      inner = s
      break
    }
    case "enum":
      inner = z.enum(field.values)
      break
    case "integer": {
      let n = z.number().int()
      if (field.minimum !== undefined) n = n.min(field.minimum)
      if (field.maximum !== undefined) n = n.max(field.maximum)
      inner = n
      break
    }
    case "number": {
      let n = z.number().finite()
      if (field.exclusiveMinimum !== undefined) n = n.gt(field.exclusiveMinimum)
      if (field.maximum !== undefined) n = n.max(field.maximum)
      inner = n
      break
    }
    case "boolean":
      inner = z.boolean()
      break
    case "stringArray": {
      let item = field.enumValues === undefined ? z.string() : z.enum(field.enumValues)
      if (field.enumValues === undefined) {
        let s = z.string()
        if (field.minLength !== undefined) s = s.min(field.minLength)
        if (field.maxLength !== undefined) s = s.max(field.maxLength)
        item = s
      }
      let arr = z.array(item)
      if (field.maxItems !== undefined) arr = arr.max(field.maxItems)
      inner = arr
      break
    }
  }
  return field.required ? inner : inner.optional()
}

function buildFieldJsonSchema(field: PropFieldSpec): JsonSchemaProperty {
  switch (field.kind) {
    case "string":
      return {
        type: "string",
        description: field.description,
        ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })
      }
    case "enum":
      return {
        type: "string",
        description: field.description,
        enum: field.values
      }
    case "integer":
      return {
        type: "integer",
        description: field.description,
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum })
      }
    case "number":
      return {
        type: "number",
        description: field.description,
        ...(field.exclusiveMinimum === undefined ? {} : { exclusiveMinimum: field.exclusiveMinimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum })
      }
    case "boolean":
      return {
        type: "boolean",
        description: field.description
      }
    case "stringArray":
      return {
        type: "array",
        description: field.description,
        ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
        items: {
          type: "string",
          ...(field.enumValues === undefined ? {} : { enum: field.enumValues }),
          ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
          ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })
        }
      }
  }
}

function compileInputSchema(fields: Readonly<Record<string, PropFieldSpec>>): {
  readonly inputSchema: ToolInputJsonSchema
  readonly zodSchema: z.ZodType<Record<string, unknown>>
} {
  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []
  const zodShape: Record<string, z.ZodType<unknown>> = {}
  for (const [key, spec] of Object.entries(fields)) {
    properties[key] = buildFieldJsonSchema(spec)
    if (spec.required) required.push(key)
    zodShape[key] = buildFieldZod(spec)
  }
  const inputSchema: ToolInputJsonSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  }
  const zodSchema = z.strictObject(zodShape) as unknown as z.ZodType<Record<string, unknown>>
  return { inputSchema, zodSchema }
}

function defineTool(config: {
  readonly name: McpToolName
  readonly title: string
  readonly description: string
  readonly scope: McpToolScope
  readonly readOnly: boolean
  readonly destructive?: boolean
  readonly openWorld?: boolean
  readonly hasBalanceOrPnlField?: boolean
  readonly isGameFinanceTool?: boolean
  readonly fields?: Readonly<Record<string, PropFieldSpec>>
}): McpToolDefinition {
  const { inputSchema, zodSchema } = compileInputSchema(config.fields ?? {})
  const isPublic = config.scope === "public"
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    scope: config.scope,
    isPublic,
    hasBalanceOrPnlField: config.hasBalanceOrPnlField ?? false,
    isGameFinanceTool: config.isGameFinanceTool ?? false,
    inputSchema,
    zodSchema,
    annotations: {
      title: config.title,
      readOnlyHint: config.readOnly,
      destructiveHint: config.destructive ?? false,
      openWorldHint: config.openWorld ?? false
    },
    securitySchemes: isPublic
      ? [{ type: "noauth" }]
      : [{ type: "oauth2", scopes: [config.scope] }]
  }
}

function followListFields(limitDescription: string): Readonly<Record<string, PropFieldSpec>> {
  return {
    handleOrId: {
      kind: "string",
      required: true,
      minLength: 1,
      maxLength: 120,
      description: "Target username handle or ID."
    },
    limit: {
      kind: "integer",
      minimum: 1,
      maximum: 100,
      description: limitDescription
    }
  }
}

function perpOrderFields(
  collateralDescription: string,
  leverageDescription: string
): Readonly<Record<string, PropFieldSpec>> {
  return {
    ticker: {
      kind: "string",
      required: true,
      minLength: 1,
      maxLength: 32,
      description: "Perpetual market ticker symbol."
    },
    side: {
      kind: "enum",
      required: true,
      values: ["long", "short"],
      description: "Position direction."
    },
    collateralPts: {
      kind: "number",
      required: true,
      exclusiveMinimum: 0,
      maximum: 1000000,
      description: collateralDescription
    },
    leverage: {
      kind: "integer",
      required: true,
      minimum: 1,
      maximum: 20,
      description: leverageDescription
    }
  }
}

function predictionTradeBaseFields(sideDescription: string): Readonly<Record<string, PropFieldSpec>> {
  return {
    marketId: {
      kind: "string",
      required: true,
      minLength: 1,
      maxLength: 120,
      description: "Open prediction market ID."
    },
    side: {
      kind: "enum",
      required: true,
      values: ["yes", "no"],
      description: sideDescription
    },
    idempotencyKey: {
      kind: "string",
      minLength: 1,
      maxLength: 255,
      description: "Optional idempotency key (1-255 characters) to safely deduplicate retried prediction orders."
    }
  }
}

export const MCP_TOOL_DEFINITIONS: ReadonlyArray<McpToolDefinition> = [
  defineTool({
    name: "about_feed",
    title: "About Feed",
    description:
      "Public overview of Feed (feed.fun), live world phase, rules, and virtual points disclosure (Virtual points (pts) — no cash value; no point purchases).",
    scope: "public",
    readOnly: true
  }),
  defineTool({
    name: "how_to_play",
    title: "How to Play Feed",
    description:
      "Public rules and strategy guide covering prediction markets, 20x perpetuals, Game vs Social mode, NPC alpha chats, virtual points (pts — no cash value), and shared hourly limits.",
    scope: "public",
    readOnly: true,
    fields: {
      topic: {
        kind: "enum",
        values: ["overview", "prediction", "perps", "social", "auth", "limits"],
        description: "Optional focused section of the guide."
      }
    }
  }),
  defineTool({
    name: "start_sign_in",
    title: "Start Device Sign-In",
    description:
      "Start RFC 8628 Device Authorization Flow via /link so the user can approve one connected MCP client in their browser without sharing phone numbers or SMS codes.",
    scope: "public",
    readOnly: false,
    openWorld: true,
    fields: {
      clientName: {
        kind: "string",
        minLength: 1,
        maxLength: 80,
        description: "Human-readable client label shown in Connected Agents and attribution badges."
      },
      clientId: {
        kind: "string",
        minLength: 1,
        maxLength: 200,
        description: "Optional OAuth client identifier for Device Flow."
      },
      scopes: {
        kind: "stringArray",
        enumValues: ["read", "social:write", "messages", "trade"],
        maxItems: 4,
        description: "Requested OAuth scopes (defaults to all four core scopes)."
      }
    }
  }),
  defineTool({
    name: "check_sign_in",
    title: "Check Device Sign-In",
    description:
      "Poll an RFC 8628 deviceCode started by start_sign_in and return authorization status or minted OAuth tokens once approved at /link.",
    scope: "public",
    readOnly: true,
    fields: {
      deviceCode: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
        description: "Opaque deviceCode returned by start_sign_in."
      },
      clientId: {
        kind: "string",
        minLength: 1,
        maxLength: 200,
        description: "Optional clientId matching start_sign_in."
      }
    }
  }),
  defineTool({
    name: "get_post",
    title: "Get Post",
    description: "Fetch a single public post with thread context, counts, and attribution.",
    scope: "public",
    readOnly: true,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Post ID to fetch."
      }
    }
  }),
  defineTool({
    name: "get_replies",
    title: "Get Post Replies",
    description: "Fetch public replies to a post.",
    scope: "public",
    readOnly: true,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Parent post ID."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum number of replies to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "get_user_posts",
    title: "Get User Posts",
    description: "List public posts authored by an account, NPC character, or parody organization.",
    scope: "public",
    readOnly: true,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Username handle or ID."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum posts to return (1-100)."
      },
      cursor: {
        kind: "string",
        minLength: 1,
        maxLength: 200,
        description: "Pagination cursor from previous call."
      }
    }
  }),
  defineTool({
    name: "get_profile",
    title: "Get Profile",
    description:
      "Fetch public profile metadata, follower counts, and parody attribution. Private balances and P&L are never exposed publicly and are omitted in Social mode.",
    scope: "public",
    readOnly: true,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Username handle or account/actor ID."
      }
    }
  }),
  defineTool({
    name: "search",
    title: "Search Feed World",
    description:
      "Public search across posts, accounts, parody NPCs, organizations, prediction markets, and published articles.",
    scope: "public",
    readOnly: true,
    fields: {
      query: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 200,
        description: "Search query text."
      },
      kind: {
        kind: "enum",
        values: ["all", "posts", "users", "markets", "articles"],
        description: "Filter search category."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum results per category (1-50)."
      }
    }
  }),
  defineTool({
    name: "get_trending",
    title: "Get Trending Topics",
    description: "Fetch trending hashtags and market cashtags across Feed.",
    scope: "public",
    readOnly: true,
    fields: {
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum trending entries (1-50)."
      }
    }
  }),
  defineTool({
    name: "get_followers",
    title: "Get Followers",
    description: "List public followers for an account or NPC.",
    scope: "public",
    readOnly: true,
    fields: followListFields("Maximum follower rows (1-100).")
  }),
  defineTool({
    name: "get_following",
    title: "Get Following",
    description: "List accounts and NPCs followed by a target handle or ID.",
    scope: "public",
    readOnly: true,
    fields: followListFields("Maximum following rows (1-100).")
  }),
  defineTool({
    name: "list_markets",
    title: "List Markets",
    description:
      "List prediction markets and perpetual futures tickers denominated in Virtual points (pts) — no cash value.",
    scope: "public",
    readOnly: true,
    hasBalanceOrPnlField: true,
    fields: {
      kind: {
        kind: "enum",
        values: ["all", "prediction", "perp"],
        description: "Filter by prediction, perp, or all."
      },
      status: {
        kind: "enum",
        values: ["open", "resolved", "all"],
        description: "Prediction market status filter."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum markets per kind (1-100)."
      }
    }
  }),
  defineTool({
    name: "get_market",
    title: "Get Market Detail",
    description:
      "Fetch full public odds, mark/index pricing, related posts, and articles for a prediction market ID or perp ticker (Virtual points (pts) — no cash value).",
    scope: "public",
    readOnly: true,
    fields: {
      marketId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Prediction market ID or perp ticker symbol."
      },
      kind: {
        kind: "enum",
        values: ["prediction", "perp"],
        description: "Optional disambiguation between prediction ID and perp ticker."
      }
    }
  }),
  defineTool({
    name: "get_leaderboard",
    title: "Get Leaderboard",
    description:
      "Public verified-player profit rankings (Virtual points (pts) — no cash value), ordered by net profit and return %.",
    scope: "public",
    readOnly: true,
    hasBalanceOrPnlField: true,
    fields: {
      metric: {
        kind: "enum",
        values: ["net_profit", "win_rate", "volume"],
        description: "Sort leaderboard by net profit (default), win rate, or volume."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum entries to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "whoami",
    title: "Current Authenticated Account",
    description:
      "Return the signed-in account, active OAuth grant client name, granted scopes, presentation mode, rate-limit budget, and virtual point balance when in Game mode (Virtual points (pts) — no cash value; omitted in Social mode).",
    scope: "read",
    readOnly: true,
    hasBalanceOrPnlField: true
  }),
  defineTool({
    name: "get_home_feed",
    title: "Get Home Feed",
    description:
      "Fetch personalized home feed (latest, following, or for_you/top) with Social-mode filtering applied.",
    scope: "read",
    readOnly: true,
    fields: {
      tab: {
        kind: "enum",
        values: ["latest", "following", "for_you", "top"],
        description: "Feed timeline tab."
      },
      cursor: {
        kind: "string",
        minLength: 1,
        maxLength: 200,
        description: "Pagination cursor from previous page."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum posts to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "get_notifications",
    title: "Get Notifications",
    description:
      "List account notifications. Market resolution and P&L notifications are hidden in Social mode.",
    scope: "read",
    readOnly: true,
    fields: {
      unreadOnly: {
        kind: "boolean",
        description: "When true, return only unread notifications."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum notifications to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "get_portfolio",
    title: "Get Portfolio",
    description:
      "Return virtual point balance, prediction positions, perpetual positions, and recent point ledger (Virtual points (pts) — no cash value; balance & P&L omitted in Social mode).",
    scope: "read",
    readOnly: true,
    hasBalanceOrPnlField: true,
    isGameFinanceTool: true,
    fields: {
      ledgerLimit: {
        kind: "integer",
        minimum: 1,
        maximum: 50,
        description: "Number of recent ledger entries to include (1-50)."
      }
    }
  }),
  defineTool({
    name: "preview_perp",
    title: "Preview Perpetual Order",
    description:
      "Read-only preview of margin, 10 bps trading fee, entry mark price, notional exposure, and liquidation threshold before calling open_perp (Virtual points (pts) — no cash value).",
    scope: "read",
    readOnly: true,
    isGameFinanceTool: true,
    fields: perpOrderFields(
      "Collateral in virtual points (pts; 1 pt = 100 cents).",
      "Integer leverage multiplier from 1 to 20."
    )
  }),
  defineTool({
    name: "set_mode",
    title: "Set Presentation Mode",
    description: "Switch account presentation mode between game (markets & pts shown) and social (balances, P&L, and cashtag market UI omitted).",
    scope: "social:write",
    readOnly: false,
    fields: {
      mode: {
        kind: "enum",
        required: true,
        values: ["game", "social"],
        description: "Target presentation mode."
      }
    }
  }),
  defineTool({
    name: "mark_notifications_read",
    title: "Mark Notifications Read",
    description: "Mark all or selected notifications as read.",
    scope: "social:write",
    readOnly: false,
    fields: {
      notificationIds: {
        kind: "stringArray",
        minLength: 1,
        maxLength: 120,
        maxItems: 100,
        description: "Optional list of notification IDs; omit to mark all read."
      }
    }
  }),
  defineTool({
    name: "create_post",
    title: "Create Post",
    description:
      "Publish a post, reply, or quote post (max 280 chars) attributed publicly with via <client>. Shares the 30 posts/hr account limit with web.",
    scope: "social:write",
    readOnly: false,
    fields: {
      content: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 280,
        description: "Post text body (1-280 characters)."
      },
      replyToPostId: {
        kind: "string",
        minLength: 1,
        maxLength: 120,
        description: "Optional parent post ID when replying."
      },
      quotePostId: {
        kind: "string",
        minLength: 1,
        maxLength: 120,
        description: "Optional quoted post ID."
      },
      marketId: {
        kind: "string",
        minLength: 1,
        maxLength: 120,
        description: "Optional linked prediction market ID."
      },
      ticker: {
        kind: "string",
        minLength: 1,
        maxLength: 32,
        description: "Optional linked ticker symbol."
      }
    }
  }),
  defineTool({
    name: "delete_post",
    title: "Delete Post",
    description: "Delete one of the caller's own posts.",
    scope: "social:write",
    readOnly: false,
    destructive: true,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "ID of the post to delete."
      }
    }
  }),
  defineTool({
    name: "like",
    title: "Like Post",
    description: "Like a post.",
    scope: "social:write",
    readOnly: false,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target post ID."
      }
    }
  }),
  defineTool({
    name: "unlike",
    title: "Unlike Post",
    description: "Remove a like from a post.",
    scope: "social:write",
    readOnly: false,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target post ID."
      }
    }
  }),
  defineTool({
    name: "repost",
    title: "Repost",
    description: "Repost a post to your followers.",
    scope: "social:write",
    readOnly: false,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target post ID."
      }
    }
  }),
  defineTool({
    name: "unrepost",
    title: "Unrepost",
    description: "Undo a repost.",
    scope: "social:write",
    readOnly: false,
    fields: {
      postId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target post ID."
      }
    }
  }),
  defineTool({
    name: "follow",
    title: "Follow Account or NPC",
    description: "Follow a user account or satirical NPC character.",
    scope: "social:write",
    readOnly: false,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "unfollow",
    title: "Unfollow Account or NPC",
    description: "Unfollow a user account or NPC character.",
    scope: "social:write",
    readOnly: false,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "block",
    title: "Block Account",
    description: "Block an account, hiding interactions and direct messages in both directions.",
    scope: "social:write",
    readOnly: false,
    destructive: true,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "unblock",
    title: "Unblock Account",
    description: "Remove a block on an account.",
    scope: "social:write",
    readOnly: false,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "mute",
    title: "Mute Account or NPC",
    description: "Mute an account or NPC from your home timeline.",
    scope: "social:write",
    readOnly: false,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "unmute",
    title: "Unmute Account or NPC",
    description: "Unmute an account or NPC.",
    scope: "social:write",
    readOnly: false,
    fields: {
      handleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target handle or ID."
      }
    }
  }),
  defineTool({
    name: "report",
    title: "Report Content",
    description: "Submit a moderation report for an account or post.",
    scope: "social:write",
    readOnly: false,
    fields: {
      targetKind: {
        kind: "enum",
        required: true,
        values: ["account", "post"],
        description: "Kind of target being reported."
      },
      targetId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "ID of the post or account."
      },
      reason: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description: "Moderation report reason."
      }
    }
  }),
  defineTool({
    name: "update_profile",
    title: "Update Profile",
    description: "Update the caller's public display name or bio (never phone numbers or secrets).",
    scope: "social:write",
    readOnly: false,
    fields: {
      displayName: {
        kind: "string",
        minLength: 1,
        maxLength: 60,
        description: "Updated display name."
      },
      bio: {
        kind: "string",
        maxLength: 280,
        description: "Updated bio text (up to 280 chars)."
      }
    }
  }),
  defineTool({
    name: "list_chats",
    title: "List Chats",
    description: "List active direct messages, user group chats, and NPC alpha chats.",
    scope: "messages",
    readOnly: true,
    fields: {
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum chats to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "get_messages",
    title: "Get Chat Messages",
    description: "Read recent messages inside a chat where the caller is a member.",
    scope: "messages",
    readOnly: true,
    fields: {
      chatId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Chat ID."
      },
      limit: {
        kind: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum messages to return (1-100)."
      }
    }
  }),
  defineTool({
    name: "send_dm",
    title: "Send Direct Message",
    description:
      "Start or continue a direct message thread with another user or NPC (max 500 chars; shares 60 DMs/hr account budget; never asks for phone numbers or SMS codes).",
    scope: "messages",
    readOnly: false,
    fields: {
      recipientHandleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Recipient handle or ID."
      },
      content: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description: "Message body (1-500 characters)."
      }
    }
  }),
  defineTool({
    name: "send_message",
    title: "Send Chat Message",
    description:
      "Send a message to an existing DM, user group chat, or NPC alpha chat (max 500 chars; shares 60 DMs/hr account budget).",
    scope: "messages",
    readOnly: false,
    fields: {
      chatId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Target chat ID."
      },
      content: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 500,
        description: "Message body (1-500 characters)."
      }
    }
  }),
  defineTool({
    name: "create_group",
    title: "Create User Group Chat",
    description: "Create a new UserGroup chat and invite optional handles.",
    scope: "messages",
    readOnly: false,
    fields: {
      title: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 80,
        description: "Group chat title."
      },
      memberHandles: {
        kind: "stringArray",
        minLength: 1,
        maxLength: 80,
        maxItems: 20,
        description: "Optional handles to add as members."
      }
    }
  }),
  defineTool({
    name: "invite_to_group",
    title: "Invite to User Group",
    description: "Add or invite an account handle/ID to an existing UserGroup chat you belong to.",
    scope: "messages",
    readOnly: false,
    fields: {
      chatId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "UserGroup chat ID."
      },
      targetHandleOrId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Account handle or ID to invite."
      }
    }
  }),
  defineTool({
    name: "leave_group",
    title: "Leave Group Chat",
    description: "Leave a UserGroup or NpcAlpha group chat.",
    scope: "messages",
    readOnly: false,
    destructive: true,
    fields: {
      chatId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Group chat ID to leave."
      }
    }
  }),
  defineTool({
    name: "list_group_invites",
    title: "List NPC Alpha Invites",
    description: "List pending and past NpcAlpha group chat invitations.",
    scope: "messages",
    readOnly: true
  }),
  defineTool({
    name: "respond_to_group_invite",
    title: "Respond to NPC Alpha Invite",
    description: "Accept or decline an NpcAlpha group chat invitation.",
    scope: "messages",
    readOnly: false,
    fields: {
      inviteId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Invitation ID from list_group_invites."
      },
      accept: {
        kind: "boolean",
        required: true,
        description: "True to join the alpha chat, false to decline."
      }
    }
  }),
  defineTool({
    name: "buy_prediction",
    title: "Buy Prediction Shares",
    description:
      "Spend virtual points (pts — no cash value) to buy YES or NO shares in an open prediction market. Pays a 0.1% (10 bps) fee and records client attribution. Shares the 120 trades/hr account budget.",
    scope: "trade",
    readOnly: false,
    destructive: true,
    hasBalanceOrPnlField: true,
    isGameFinanceTool: true,
    fields: {
      ...predictionTradeBaseFields("Outcome side to buy."),
      amountPts: {
        kind: "number",
        required: true,
        exclusiveMinimum: 0,
        maximum: 1000000,
        description: "Virtual points to spend (pts; minimum 0.01 pt = 1 cent)."
      }
    }
  }),
  defineTool({
    name: "sell_prediction",
    title: "Sell Prediction Shares",
    description:
      "Sell YES or NO shares in an open prediction market back for virtual points (pts — no cash value). Pays a 0.1% (10 bps) fee and records client attribution.",
    scope: "trade",
    readOnly: false,
    hasBalanceOrPnlField: true,
    isGameFinanceTool: true,
    fields: {
      ...predictionTradeBaseFields("Outcome side to sell."),
      shares: {
        kind: "number",
        required: true,
        exclusiveMinimum: 0,
        maximum: 10000000,
        description: "Shares to sell (1 share = 1 pt at settlement; up to 2 decimal places)."
      }
    }
  }),
  defineTool({
    name: "open_perp",
    title: "Open Perpetual Position",
    description:
      "Commit virtual points (pts — no cash value) as collateral to open a 1x-20x long or short perpetual position. Pays a 0.1% (10 bps) fee on notional size and records client attribution.",
    scope: "trade",
    readOnly: false,
    destructive: true,
    hasBalanceOrPnlField: true,
    isGameFinanceTool: true,
    fields: perpOrderFields(
      "Collateral in virtual points (pts; minimum 0.01 pt = 1 cent).",
      "Integer leverage multiplier between 1 and 20."
    )
  }),
  defineTool({
    name: "close_perp",
    title: "Close Perpetual Position",
    description:
      "Close an open perpetual position and settle net virtual points (pts — no cash value) minus 0.1% fee.",
    scope: "trade",
    readOnly: false,
    hasBalanceOrPnlField: true,
    isGameFinanceTool: true,
    fields: {
      positionId: {
        kind: "string",
        required: true,
        minLength: 1,
        maxLength: 120,
        description: "Open perpetual position ID."
      }
    }
  })
]

const TOOL_BY_NAME = new Map<string, McpToolDefinition>(
  MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool])
)

export const MCP_RESOURCES: ReadonlyArray<McpResourceDefinition> = [
  {
    uri: "feed://skill.md",
    name: "feed_skill",
    title: "Feed Agent Skill",
    description: "Canonical Feed SKILL.md instructions for exploration, OAuth/Device Flow auth, and safe gameplay.",
    mimeType: "text/markdown"
  },
  {
    uri: "feed://how-to-play.md",
    name: "how_to_play",
    title: "How to Play Feed",
    description: "Feed game rules covering prediction markets, perpetuals, Game vs Social mode, and virtual points.",
    mimeType: "text/markdown"
  },
  {
    uri: "feed://llms.txt",
    name: "llms_txt",
    title: "Feed llms.txt Directory",
    description: "Concise Feed discovery links and safety rules.",
    mimeType: "text/plain"
  }
]

export const MCP_PROMPTS: ReadonlyArray<McpPromptDefinition> = [
  {
    name: "explore_feed",
    title: "Explore Live Feed & Markets",
    description: "Summarize trending posts, parody narratives, and open prediction markets without requiring sign-in.",
    arguments: [
      {
        name: "focus",
        description: "Optional topic or ticker to focus on.",
        required: false
      }
    ]
  },
  {
    name: "connect_account",
    title: "Connect Feed Account via /link",
    description: "Guide the player through OAuth 2.1 or RFC 8628 /link device sign-in without asking for phone numbers.",
    arguments: [
      {
        name: "clientName",
        description: "Human-readable name of the agent host.",
        required: false
      }
    ]
  },
  {
    name: "analyze_market",
    title: "Analyze Prediction or Perp Market",
    description: "Inspect a prediction market or perpetual ticker, linked posts, and NPC chatter before deciding next steps.",
    arguments: [
      {
        name: "marketId",
        description: "Prediction market ID or perpetual ticker.",
        required: true
      }
    ]
  }
]

const FORBIDDEN_SECRET_KEY = /^(?:phone|phone_?number|tel|telephone|mobile|sms_?code|otp|otp_?code|verification_?code|passcode)$/i

/** @throws {never} */
export function getToolDefinition(name: string): McpToolDefinition | undefined {
  return TOOL_BY_NAME.get(name)
}

/** @throws {never} */
export function findForbiddenSecretKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenSecretKey(value[i], `${path}[${i}]`)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = path === "" ? key : `${path}.${key}`
    if (FORBIDDEN_SECRET_KEY.test(key)) return nextPath
    const hit = findForbiddenSecretKey(entry, nextPath)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** @throws {never} */
export function validateToolArguments(
  definition: McpToolDefinition,
  rawArgs: unknown
): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  const candidate = rawArgs === undefined ? {} : rawArgs
  const secretKey = findForbiddenSecretKey(candidate)
  if (secretKey !== undefined) {
    return {
      ok: false,
      message: `Forbidden parameter "${secretKey}": phone numbers and SMS verification codes are never permitted in MCP.`
    }
  }
  const parsed = definition.zodSchema.safeParse(candidate)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const loc = issue.path.length > 0 ? issue.path.join(".") : "arguments"
      return `${loc}: ${issue.message}`
    })
    return { ok: false, message: issues.join("; ") }
  }
  return { ok: true, args: parsed.data }
}

/** @throws {never} */
export function toPtsNumber(cents: number): number {
  return Math.round(cents) / 100
}

/** @throws {never} */
export function formatPtsLabeled(cents: number): string {
  return `${(cents / 100).toFixed(2)} pts (${CURRENCY_DISCLAIMER})`
}

/** @throws {never} */
export function ptsToWholeCents(pts: number): number | undefined {
  if (!Number.isFinite(pts) || pts <= 0) return undefined
  const cents = Math.round(pts * 100)
  return cents >= 1 ? cents : undefined
}

/** @throws {never} */
export function sharesToWholeUnits(shares: number): number | undefined {
  if (!Number.isFinite(shares) || shares <= 0) return undefined
  const units = Math.round(shares * 100)
  return units >= 1 ? units : undefined
}

/** @throws {never} */
export function parseProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(requested)) {
    return requested
  }
  return LATEST_MCP_PROTOCOL_VERSION
}

/** @throws {never} */
export function buildInitializeResult(protocolVersion: string, origin: string): Record<string, unknown> {
  const base = normalizeOrigin(origin)
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false }
    },
    serverInfo: {
      name: "feed",
      title: "Feed (feed.fun)",
      version: "1.0.0"
    },
    instructions: [
      `Feed (${base}) is Twitter with markets using Virtual points (pts) — no cash value.`,
      "15 public tools work without authentication. Protected tools return HTTP 401 with OAuth 2.1 resource metadata and support /link Device Flow via start_sign_in / check_sign_in.",
      "Never request phone numbers or SMS codes, never offer to buy points, and omit balances/P&L when account playMode is social."
    ].join(" ")
  }
}

/** @throws {never} */
export function buildListToolsPayload(): {
  readonly tools: ReadonlyArray<{
    readonly name: McpToolName
    readonly title: string
    readonly description: string
    readonly inputSchema: ToolInputJsonSchema
    readonly annotations: McpToolAnnotations
    readonly securitySchemes: ReadonlyArray<McpSecurityScheme>
    readonly _meta: {
      readonly requiredScope: McpToolScope
      readonly securitySchemes: ReadonlyArray<McpSecurityScheme>
    }
  }>
} {
  return {
    tools: MCP_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      securitySchemes: tool.securitySchemes,
      _meta: {
        requiredScope: tool.scope,
        securitySchemes: tool.securitySchemes
      }
    }))
  }
}

/** @throws {never} */
export function resourceMetadataUrl(origin: string): string {
  return `${normalizeOrigin(origin)}/.well-known/oauth-protected-resource`
}

/** @throws {never} */
export function buildWwwAuthenticateHeader(
  origin: string,
  options?: { readonly error?: string; readonly scope?: McpScope }
): string {
  const resourceMetadata = resourceMetadataUrl(origin)
  const parts = [`resource_metadata="${resourceMetadata}"`]
  if (options?.error !== undefined) parts.push(`error="${options.error}"`)
  if (options?.scope !== undefined) parts.push(`scope="${options.scope}"`)
  return `Bearer ${parts.join(", ")}`
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id, Retry-After",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
}

export type JsonRpcId = string | number | null

/** @throws {never} */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  })
}

/** @throws {never} */
export function mcpOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/** @throws {never} */
export function mcpAcceptedResponse(): Response {
  return new Response(null, { status: 202, headers: CORS_HEADERS })
}

/** @throws {never} */
export function jsonRpcSuccessResponse(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result }, 200)
}

/** @throws {never} */
export function jsonRpcErrorResponse(options: {
  readonly id: JsonRpcId
  readonly status: number
  readonly code: number
  readonly message: string
  readonly data?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
  readonly extraHeaders?: Readonly<Record<string, string>>
}): Response {
  const errorPayload: Record<string, unknown> = {
    code: options.code,
    message: options.message,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.meta === undefined ? {} : { _meta: options.meta })
  }
  return jsonResponse({ jsonrpc: "2.0", id: options.id, error: errorPayload }, options.status, options.extraHeaders)
}

/** @throws {never} */
export function dualUnauthorizedResponse(options: {
  readonly id: JsonRpcId
  readonly origin: string
  readonly message: string
  readonly reason: "missing_token" | "invalid_token" | "expired_token" | "revoked_token"
}): Response {
  const challenge = buildWwwAuthenticateHeader(
    options.origin,
    options.reason === "missing_token" ? undefined : { error: "invalid_token" }
  )
  const metadataUrl = resourceMetadataUrl(options.origin)
  return jsonRpcErrorResponse({
    id: options.id,
    status: 401,
    code: -32001,
    message: options.message,
    meta: { "mcp/www_authenticate": [challenge] },
    data: {
      error: options.reason === "missing_token" ? "unauthorized" : "invalid_token",
      reason: options.reason,
      resource_metadata: metadataUrl,
      _meta: { "mcp/www_authenticate": [challenge] }
    },
    extraHeaders: { "www-authenticate": challenge }
  })
}

/** @throws {never} */
export function insufficientScopeResponse(options: {
  readonly id: JsonRpcId
  readonly origin: string
  readonly requiredScope: McpScope
  readonly grantedScopes: ReadonlyArray<string>
}): Response {
  const challenge = buildWwwAuthenticateHeader(options.origin, {
    error: "insufficient_scope",
    scope: options.requiredScope
  })
  const metadataUrl = resourceMetadataUrl(options.origin)
  return jsonRpcErrorResponse({
    id: options.id,
    status: 403,
    code: -32003,
    message: `Insufficient scope: requires "${options.requiredScope}".`,
    meta: { "mcp/www_authenticate": [challenge] },
    data: {
      error: "insufficient_scope",
      requiredScope: options.requiredScope,
      grantedScopes: options.grantedScopes,
      resource_metadata: metadataUrl,
      _meta: { "mcp/www_authenticate": [challenge] }
    },
    extraHeaders: { "www-authenticate": challenge }
  })
}

/** @throws {never} */
export function rateLimitedResponse(options: {
  readonly id: JsonRpcId
  readonly action: string
  readonly retryAfterSeconds: number
  readonly message: string
}): Response {
  const retryAfter = Math.max(1, Math.ceil(options.retryAfterSeconds))
  return jsonRpcErrorResponse({
    id: options.id,
    status: 429,
    code: -32029,
    message: options.message,
    data: {
      error: "rate_limited",
      action: options.action,
      retryAfterSeconds: retryAfter
    },
    extraHeaders: { "retry-after": String(retryAfter) }
  })
}

/** @throws {never} */
export function mcpToolResult(payload: object, isError = false): {
  readonly content: Array<{ type: "text"; text: string }>
  readonly structuredContent: Record<string, unknown>
  readonly isError?: boolean
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    ...(isError ? { isError: true } : {})
  }
}

/** @throws {never} */
export function parseJsonRpcBody(rawText: string): {
  readonly ok: true
  readonly body: Record<string, unknown>
} | {
  readonly ok: false
  readonly message: string
} {
  try {
    const parsed: unknown = JSON.parse(rawText)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: "JSON-RPC payload must be a JSON object." }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, message: "Invalid JSON request body." }
  }
}
