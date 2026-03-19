// ---------------------------------------------------------------------------
// Monday.com GraphQL API Client with board-level access control
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

const MONDAY_API_URL = "https://api.monday.com/v2";
// 2024-10 was deprecated on Feb 15 2026; 2025-04 is now the current stable version.
const MONDAY_API_VERSION = "2025-04";

export interface AllowlistConfig {
  boards: Array<{
    id: string;
    name?: string;      // friendly name for reference
    addedAt: string;     // ISO timestamp
    source: "env" | "runtime";
  }>;
}

export class MondayClient {
  private apiToken: string;
  private allowedBoardIds: Set<string>;
  private allowlistPath: string;
  private allowlistConfig: AllowlistConfig;

  constructor() {
    const token = process.env.MONDAY_API_TOKEN;
    if (!token) {
      throw new Error(
        "MONDAY_API_TOKEN environment variable is required. " +
        "Get one from: monday.com > Profile > Admin > API"
      );
    }
    this.apiToken = token;

    // Persistent allowlist file location
    const stateDir = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
    this.allowlistPath = path.join(stateDir, "monday-allowed-boards.json");

    // Load allowlist from file (if exists) and merge with env var
    this.allowlistConfig = this.loadAllowlist();
    this.allowedBoardIds = new Set(this.allowlistConfig.boards.map((b) => b.id));

    console.error(
      `[monday] Initialized with ${this.allowedBoardIds.size} allowed board(s): ${[...this.allowedBoardIds].join(", ")}`
    );
  }

  // ---- Allowlist management ------------------------------------------------

  private loadAllowlist(): AllowlistConfig {
    let config: AllowlistConfig = { boards: [] };

    // Load persisted runtime boards
    try {
      if (fs.existsSync(this.allowlistPath)) {
        const raw = fs.readFileSync(this.allowlistPath, "utf-8");
        config = JSON.parse(raw);
        console.error(`[monday] Loaded ${config.boards.length} board(s) from persistent allowlist`);
      }
    } catch (err) {
      console.error(`[monday] Warning: Could not load allowlist file: ${(err as Error).message}`);
    }

    // Merge env var boards (these always take priority / are always present).
    // Supports two formats:
    //   - plain IDs:       "1234567890,9876543210"
    //   - named IDs:       "1234567890:Sales Pipeline,9876543210:Project Tracker"
    // Named format lets the AI immediately know what each board is.
    const envEntries = (process.env.MONDAY_BOARD_IDS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (const entry of envEntries) {
      const colonIdx = entry.indexOf(":");
      const id = colonIdx >= 0 ? entry.slice(0, colonIdx).trim() : entry;
      const name = colonIdx >= 0 ? entry.slice(colonIdx + 1).trim() || undefined : undefined;
      if (!config.boards.find((b) => b.id === id)) {
        config.boards.push({
          id,
          name,
          addedAt: new Date().toISOString(),
          source: "env",
        });
      }
    }

    return config;
  }

  private saveAllowlist(): void {
    try {
      const dir = path.dirname(this.allowlistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.allowlistPath, JSON.stringify(this.allowlistConfig, null, 2));
    } catch (err) {
      console.error(`[monday] Warning: Could not save allowlist: ${(err as Error).message}`);
    }
  }

  getAllowedBoards(): AllowlistConfig["boards"] {
    return this.allowlistConfig.boards;
  }

  addBoard(boardId: string, name?: string): { added: boolean; message: string } {
    if (this.allowedBoardIds.has(boardId)) {
      return { added: false, message: `Board ${boardId} is already in the allowlist` };
    }
    this.allowlistConfig.boards.push({
      id: boardId,
      name,
      addedAt: new Date().toISOString(),
      source: "runtime",
    });
    this.allowedBoardIds.add(boardId);
    this.saveAllowlist();
    return { added: true, message: `Board ${boardId}${name ? ` (${name})` : ""} added to allowlist` };
  }

  removeBoard(boardId: string): { removed: boolean; message: string } {
    if (!this.allowedBoardIds.has(boardId)) {
      return { removed: false, message: `Board ${boardId} is not in the allowlist` };
    }
    const board = this.allowlistConfig.boards.find((b) => b.id === boardId);
    if (board?.source === "env") {
      return {
        removed: false,
        message: `Board ${boardId} was added via MONDAY_BOARD_IDS env var and cannot be removed at runtime. Remove it from the env var instead.`,
      };
    }
    this.allowlistConfig.boards = this.allowlistConfig.boards.filter((b) => b.id !== boardId);
    this.allowedBoardIds.delete(boardId);
    this.saveAllowlist();
    return { removed: true, message: `Board ${boardId} removed from allowlist` };
  }

  assertBoardAllowed(boardId: string): void {
    if (this.allowedBoardIds.size === 0) {
      throw new Error(
        "No boards are configured in the allowlist. " +
        "Use add_allowed_board to add boards, or set MONDAY_BOARD_IDS env var."
      );
    }
    if (!this.allowedBoardIds.has(String(boardId))) {
      throw new Error(
        `Access denied: Board ${boardId} is not in the allowlist. ` +
        `Allowed boards: ${[...this.allowedBoardIds].join(", ")}. ` +
        `Use the list_allowed_boards tool to see all allowed boards, ` +
        `or add_allowed_board to grant access.`
      );
    }
  }

  // ---- GraphQL helper -------------------------------------------------------

  async query(graphql: string, variables?: Record<string, unknown>): Promise<unknown> {
    const body: Record<string, unknown> = { query: graphql };
    if (variables) body.variables = variables;

    const res = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiToken,
        "API-Version": MONDAY_API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Monday API HTTP ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw new Error(`Monday API error: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    return json.data;
  }

  // ---- Board operations (all gated by allowlist) ----------------------------

  async getBoard(boardId: string): Promise<unknown> {
    this.assertBoardAllowed(boardId);
    const data = await this.query(`
      query ($ids: [ID!]!) {
        boards(ids: $ids) {
          id
          name
          description
          state
          board_kind
          columns { id title type settings_str }
          groups { id title color position }
          owners { id name email }
          items_count
        }
      }
    `, { ids: [boardId] });
    return (data as { boards: unknown[] }).boards[0] ?? null;
  }

  async getItems(
    boardId: string,
    options?: {
      groupId?: string;
      columnId?: string;
      columnValue?: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const limit = options?.limit ?? 50;

    // ---- Cursor-based pagination (subsequent pages) -------------------------
    // Per Monday.com docs: after the first page, use the top-level
    // next_items_page query with the cursor returned from the previous call.
    if (options?.cursor) {
      const data = await this.query(`
        query ($cursor: String!, $limit: Int!) {
          next_items_page(cursor: $cursor, limit: $limit) {
            cursor
            items {
              id
              name
              state
              group { id title }
              column_values { id text type value }
              created_at
              updated_at
            }
          }
        }
      `, { cursor: options.cursor, limit });
      return (data as { next_items_page: unknown }).next_items_page;
    }

    // ---- Column value filter ------------------------------------------------
    // Use items_page_by_column_values when a specific column/value filter is given.
    if (options?.columnId && options?.columnValue) {
      const data = await this.query(`
        query ($boardId: ID!, $columns: [ItemsByColumnValuesQuery!]!, $limit: Int!) {
          items_page_by_column_values(
            board_id: $boardId
            limit: $limit
            columns: $columns
          ) {
            cursor
            items {
              id
              name
              state
              group { id title }
              column_values { id text type value }
              created_at
              updated_at
            }
          }
        }
      `, {
        boardId,
        limit,
        columns: [{ column_id: options.columnId, column_values: [options.columnValue] }],
      });
      return (data as { items_page_by_column_values: unknown }).items_page_by_column_values;
    }

    // ---- Group filter -------------------------------------------------------
    // Nest items_page inside groups(ids: [...]) for a clean group-scoped query.
    if (options?.groupId) {
      const data = await this.query(`
        query ($boardId: ID!, $groupId: String!, $limit: Int!) {
          boards(ids: [$boardId]) {
            groups(ids: [$groupId]) {
              id
              title
              items_page(limit: $limit) {
                cursor
                items {
                  id
                  name
                  state
                  group { id title }
                  column_values { id text type value }
                  created_at
                  updated_at
                }
              }
            }
          }
        }
      `, { boardId, groupId: options.groupId, limit });
      const group = (data as {
        boards: Array<{ groups: Array<{ items_page: unknown }> }>;
      }).boards[0]?.groups[0];
      return group?.items_page ?? null;
    }

    // ---- No filter (all items, first page) ----------------------------------
    const data = await this.query(`
      query ($boardId: ID!, $limit: Int!) {
        boards(ids: [$boardId]) {
          items_page(limit: $limit) {
            cursor
            items {
              id
              name
              state
              group { id title }
              column_values { id text type value }
              created_at
              updated_at
            }
          }
        }
      }
    `, { boardId, limit });

    return (data as { boards: Array<{ items_page: unknown }> }).boards[0]?.items_page ?? null;
  }

  async createItem(
    boardId: string,
    itemName: string,
    options?: {
      groupId?: string;
      columnValues?: Record<string, unknown>;
    }
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($boardId: ID!, $itemName: String!, $groupId: String, $columnValues: JSON) {
        create_item(
          board_id: $boardId
          item_name: $itemName
          group_id: $groupId
          column_values: $columnValues
        ) {
          id
          name
          group { id title }
          column_values { id text type value }
          created_at
        }
      }
    `, {
      boardId,
      itemName,
      groupId: options?.groupId ?? null,
      columnValues: options?.columnValues ? JSON.stringify(options.columnValues) : null,
    });

    return (data as { create_item: unknown }).create_item;
  }

  async updateItem(
    boardId: string,
    itemId: string,
    columnValues: Record<string, unknown>
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId
          item_id: $itemId
          column_values: $columnValues
        ) {
          id
          name
          column_values { id text type value }
        }
      }
    `, {
      boardId,
      itemId,
      columnValues: JSON.stringify(columnValues),
    });

    return (data as { change_multiple_column_values: unknown }).change_multiple_column_values;
  }

  async deleteItem(itemId: string, boardId: string): Promise<unknown> {
    // We need the boardId to check the allowlist, even though the mutation only needs itemId
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($itemId: ID!) {
        delete_item(item_id: $itemId) {
          id
        }
      }
    `, { itemId });

    return (data as { delete_item: unknown }).delete_item;
  }

  async moveItemToGroup(
    boardId: string,
    itemId: string,
    groupId: string
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($itemId: ID!, $groupId: String!) {
        move_item_to_group(item_id: $itemId, group_id: $groupId) {
          id
          name
          group { id title }
        }
      }
    `, { itemId, groupId });

    return (data as { move_item_to_group: unknown }).move_item_to_group;
  }

  async createSubitem(
    parentItemId: string,
    boardId: string,
    itemName: string,
    columnValues?: Record<string, unknown>
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($parentItemId: ID!, $itemName: String!, $columnValues: JSON) {
        create_subitem(
          parent_item_id: $parentItemId
          item_name: $itemName
          column_values: $columnValues
        ) {
          id
          name
          column_values { id text type value }
          created_at
          board { id name }
        }
      }
    `, {
      parentItemId,
      itemName,
      columnValues: columnValues ? JSON.stringify(columnValues) : null,
    });

    return (data as { create_subitem: unknown }).create_subitem;
  }

  async getUpdates(
    itemId: string,
    boardId: string,
    limit: number = 25
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      query ($ids: [ID!]!, $limit: Int!) {
        items(ids: $ids) {
          updates(limit: $limit) {
            id
            body
            text_body
            created_at
            creator { id name email }
            replies {
              id
              body
              text_body
              created_at
              creator { id name email }
            }
          }
        }
      }
    `, { ids: [itemId], limit });

    return (data as { items: Array<{ updates: unknown }> }).items[0]?.updates ?? [];
  }

  async createUpdate(
    itemId: string,
    boardId: string,
    body: string
  ): Promise<unknown> {
    this.assertBoardAllowed(boardId);

    const data = await this.query(`
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
          body
          created_at
        }
      }
    `, { itemId, body });

    return (data as { create_update: unknown }).create_update;
  }
}
