#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { MondayClient } from "./monday-client.js";

// ---------------------------------------------------------------------------
// Bootstrap Monday client (validates required env vars on startup)
// ---------------------------------------------------------------------------
let monday: MondayClient;
try {
  monday = new MondayClient();
} catch (err) {
  console.error("[monday] Fatal:", (err as Error).message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "monday-boards", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ---- Access control tools ----
    {
      name: "list_allowed_boards",
      description:
        "List all Monday.com boards that this server is allowed to access. " +
        "Shows board IDs, friendly names, how they were added (env var or runtime), and when.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "add_allowed_board",
      description:
        "Add a Monday.com board to the allowlist so this server can access it. " +
        "The board ID is required. Optionally provide a friendly name for reference. " +
        "Changes are persisted to disk and survive restarts.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID to allow access to",
          },
          name: {
            type: "string",
            description: "Optional friendly name for this board (e.g. 'Sales Pipeline')",
          },
        },
        required: ["boardId"],
      },
    },
    {
      name: "remove_allowed_board",
      description:
        "Remove a Monday.com board from the allowlist. " +
        "Only boards added at runtime can be removed. " +
        "Boards added via the MONDAY_BOARD_IDS env var cannot be removed here.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID to remove from the allowlist",
          },
        },
        required: ["boardId"],
      },
    },

    // ---- Board info ----
    {
      name: "get_board",
      description:
        "Get detailed information about a Monday.com board including its columns, groups, " +
        "owners, and item count. Use this to understand a board's structure before working with items. " +
        "The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID",
          },
        },
        required: ["boardId"],
      },
    },

    // ---- Item operations ----
    {
      name: "get_items",
      description:
        "Get items from a Monday.com board with optional filtering by group or column value. " +
        "Returns item names, column values, group, and timestamps. Supports pagination via cursor. " +
        "The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID",
          },
          groupId: {
            type: "string",
            description: "Optional: filter items by group ID",
          },
          columnId: {
            type: "string",
            description: "Optional: filter by column ID (must also provide columnValue)",
          },
          columnValue: {
            type: "string",
            description: "Optional: the value to match in the specified column",
          },
          limit: {
            type: "number",
            description: "Max items to return (default 50, max 500)",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor from a previous get_items response",
          },
        },
        required: ["boardId"],
      },
    },
    {
      name: "create_item",
      description:
        "Create a new item on a Monday.com board. You can specify a group and set column values. " +
        "Use get_board first to understand the column structure and available groups. " +
        "The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID",
          },
          itemName: {
            type: "string",
            description: "Name for the new item",
          },
          groupId: {
            type: "string",
            description: "Optional: group ID to create the item in",
          },
          columnValues: {
            type: "object",
            description:
              "Optional: column values as a JSON object. Keys are column IDs, values depend on column type. " +
              'Example: {"status": {"label": "Done"}, "date4": {"date": "2025-03-15"}}',
          },
        },
        required: ["boardId", "itemName"],
      },
    },
    {
      name: "update_item",
      description:
        "Update column values of an existing item on a Monday.com board. " +
        "Use get_board to understand the column structure first. " +
        "The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID",
          },
          itemId: {
            type: "string",
            description: "The item ID to update",
          },
          columnValues: {
            type: "object",
            description:
              "Column values to update as a JSON object. Keys are column IDs. " +
              'Example: {"status": {"label": "Working on it"}, "text0": "Updated text"}',
          },
        },
        required: ["boardId", "itemId", "columnValues"],
      },
    },
    {
      name: "delete_item",
      description:
        "Delete an item from a Monday.com board. This is permanent and cannot be undone. " +
        "The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID (for access control verification)",
          },
          itemId: {
            type: "string",
            description: "The item ID to delete",
          },
        },
        required: ["boardId", "itemId"],
      },
    },
    {
      name: "move_item_to_group",
      description:
        "Move an item to a different group within the same Monday.com board. " +
        "Use get_board to see available groups. The board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID",
          },
          itemId: {
            type: "string",
            description: "The item ID to move",
          },
          groupId: {
            type: "string",
            description: "The target group ID to move the item to",
          },
        },
        required: ["boardId", "itemId", "groupId"],
      },
    },

    // ---- Subitems ----
    {
      name: "create_subitem",
      description:
        "Create a subitem under an existing item on a Monday.com board. " +
        "The parent item's board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID of the parent item (for access control)",
          },
          parentItemId: {
            type: "string",
            description: "The parent item ID to create the subitem under",
          },
          itemName: {
            type: "string",
            description: "Name for the new subitem",
          },
          columnValues: {
            type: "object",
            description: "Optional: column values for the subitem",
          },
        },
        required: ["boardId", "parentItemId", "itemName"],
      },
    },

    // ---- Updates (comments) ----
    {
      name: "get_updates",
      description:
        "Get the updates (comments/activity) on a Monday.com item. " +
        "Returns the update body, creator, timestamp, and any replies. " +
        "The item's board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID (for access control)",
          },
          itemId: {
            type: "string",
            description: "The item ID to get updates for",
          },
          limit: {
            type: "number",
            description: "Max number of updates to return (default 25)",
          },
        },
        required: ["boardId", "itemId"],
      },
    },
    {
      name: "create_update",
      description:
        "Post an update (comment) on a Monday.com item. " +
        "Supports basic HTML formatting in the body. " +
        "The item's board must be in the allowlist.",
      inputSchema: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description: "The Monday.com board ID (for access control)",
          },
          itemId: {
            type: "string",
            description: "The item ID to post the update on",
          },
          body: {
            type: "string",
            description: "The update content (supports basic HTML)",
          },
        },
        required: ["boardId", "itemId", "body"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ---- Access control --------------------------------------------------
      case "list_allowed_boards": {
        const boards = monday.getAllowedBoards();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  totalBoards: boards.length,
                  boards: boards.map((b) => ({
                    id: b.id,
                    name: b.name ?? "(no name set)",
                    source: b.source,
                    addedAt: b.addedAt,
                  })),
                  note:
                    boards.length === 0
                      ? "No boards are configured. Use add_allowed_board to grant access to specific boards."
                      : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "add_allowed_board": {
        const { boardId, name: boardName } = args as { boardId: string; name?: string };
        if (!boardId) throw new McpError(ErrorCode.InvalidParams, "boardId is required");
        const result = monday.addBoard(boardId, boardName);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "remove_allowed_board": {
        const { boardId } = args as { boardId: string };
        if (!boardId) throw new McpError(ErrorCode.InvalidParams, "boardId is required");
        const result = monday.removeBoard(boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // ---- Board info ------------------------------------------------------
      case "get_board": {
        const { boardId } = args as { boardId: string };
        if (!boardId) throw new McpError(ErrorCode.InvalidParams, "boardId is required");
        const board = await monday.getBoard(boardId);
        return {
          content: [{ type: "text", text: JSON.stringify(board, null, 2) }],
        };
      }

      // ---- Items -----------------------------------------------------------
      case "get_items": {
        const params = args as {
          boardId: string;
          groupId?: string;
          columnId?: string;
          columnValue?: string;
          limit?: number;
          cursor?: string;
        };
        if (!params.boardId) throw new McpError(ErrorCode.InvalidParams, "boardId is required");
        const result = await monday.getItems(params.boardId, {
          groupId: params.groupId,
          columnId: params.columnId,
          columnValue: params.columnValue,
          limit: params.limit,
          cursor: params.cursor,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "create_item": {
        const params = args as {
          boardId: string;
          itemName: string;
          groupId?: string;
          columnValues?: Record<string, unknown>;
        };
        if (!params.boardId || !params.itemName) {
          throw new McpError(ErrorCode.InvalidParams, "boardId and itemName are required");
        }
        const result = await monday.createItem(params.boardId, params.itemName, {
          groupId: params.groupId,
          columnValues: params.columnValues,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "update_item": {
        const params = args as {
          boardId: string;
          itemId: string;
          columnValues: Record<string, unknown>;
        };
        if (!params.boardId || !params.itemId || !params.columnValues) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "boardId, itemId, and columnValues are required"
          );
        }
        const result = await monday.updateItem(
          params.boardId,
          params.itemId,
          params.columnValues
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "delete_item": {
        const params = args as { boardId: string; itemId: string };
        if (!params.boardId || !params.itemId) {
          throw new McpError(ErrorCode.InvalidParams, "boardId and itemId are required");
        }
        const result = await monday.deleteItem(params.itemId, params.boardId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ deleted: true, itemId: params.itemId }, null, 2),
            },
          ],
        };
      }

      case "move_item_to_group": {
        const params = args as { boardId: string; itemId: string; groupId: string };
        if (!params.boardId || !params.itemId || !params.groupId) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "boardId, itemId, and groupId are required"
          );
        }
        const result = await monday.moveItemToGroup(
          params.boardId,
          params.itemId,
          params.groupId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // ---- Subitems --------------------------------------------------------
      case "create_subitem": {
        const params = args as {
          boardId: string;
          parentItemId: string;
          itemName: string;
          columnValues?: Record<string, unknown>;
        };
        if (!params.boardId || !params.parentItemId || !params.itemName) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "boardId, parentItemId, and itemName are required"
          );
        }
        const result = await monday.createSubitem(
          params.parentItemId,
          params.boardId,
          params.itemName,
          params.columnValues
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // ---- Updates (comments) ----------------------------------------------
      case "get_updates": {
        const params = args as { boardId: string; itemId: string; limit?: number };
        if (!params.boardId || !params.itemId) {
          throw new McpError(ErrorCode.InvalidParams, "boardId and itemId are required");
        }
        const result = await monday.getUpdates(params.itemId, params.boardId, params.limit);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "create_update": {
        const params = args as { boardId: string; itemId: string; body: string };
        if (!params.boardId || !params.itemId || !params.body) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "boardId, itemId, and body are required"
          );
        }
        const result = await monday.createUpdate(params.itemId, params.boardId, params.body);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Monday.com API error",
              message: (err as Error).message,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const boards = monday.getAllowedBoards();
  console.error(
    `[monday] MCP server running. ${boards.length} board(s) in allowlist.`
  );
}

main().catch((err) => {
  console.error("[monday] Startup error:", err);
  process.exit(1);
});
