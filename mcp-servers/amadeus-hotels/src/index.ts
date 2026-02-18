#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { isAxiosError } from "axios";
import { AmadeusClient, SUPPLIER_CODES } from "./amadeus-client.js";
import {
  SearchHotelsByCity,
  GetHotelOffers,
  GetHotelOfferById,
  SearchHotelsByGeocode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Bootstrap Amadeus client (validates required env vars on startup)
// ---------------------------------------------------------------------------
let amadeus: AmadeusClient;
try {
  amadeus = new AmadeusClient();
} catch (err) {
  console.error("[amadeus-hotels] Fatal:", (err as Error).message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "amadeus-hotels", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_hotels_by_city",
      description:
        "Search for hotels in a city using its IATA city code (e.g. TLV, PAR, LON, NYC). " +
        "Returns hotel IDs and basic info (name, chain, rating, address). " +
        "No pricing here – use get_hotel_offers to check availability and rates. " +
        "Tip: filter ratings=['4','5'] for 4-5 star only, chainCodes to prefer specific brands.",
      inputSchema: {
        type: "object",
        properties: {
          cityCode: {
            type: "string",
            description:
              "IATA 3-letter city code. Examples: TLV=Tel Aviv, PAR=Paris, NYC=New York, " +
              "LON=London, ROM=Rome, BCN=Barcelona, AMS=Amsterdam, BER=Berlin, MAD=Madrid, " +
              "MUC=Munich, FRA=Frankfurt, ZRH=Zurich, GVA=Geneva",
          },
          radius: {
            type: "number",
            description: "Search radius from city center in KM (1-100, default 20)",
          },
          radiusUnit: {
            type: "string",
            enum: ["KM", "MILE"],
            description: "Unit for the radius (default KM)",
          },
          chainCodes: {
            type: "array",
            items: { type: "string" },
            description:
              "Hotel chain codes to restrict results. Common codes: " +
              "HH=Hilton, MC=Marriott, IC=InterContinental, FS=Four Seasons, " +
              "MO=Mandarin Oriental, HY=Hyatt, WI=Westin, SI=Sheraton, RT=Radisson",
          },
          amenities: {
            type: "array",
            items: { type: "string" },
            description:
              "Amenity filters. Options: SWIMMING_POOL, SPA, FITNESS_CENTER, " +
              "RESTAURANT, BAR, PARKING, WIFI, BUSINESS_CENTER, AIRPORT_SHUTTLE",
          },
          ratings: {
            type: "array",
            items: { type: "string" },
            description:
              "Star ratings to include. Use ['5'] for 5-star only, ['4','5'] for 4-5 star, etc.",
          },
          hotelSource: {
            type: "string",
            enum: ["BEDBANK", "DIRECTCHAIN", "ALL"],
            description:
              "Content source. DIRECTCHAIN = chain-direct inventory (best for negotiated rates). Default: ALL",
          },
        },
        required: ["cityCode"],
      },
    },
    {
      name: "search_hotels_by_geocode",
      description:
        "Search for hotels near a specific latitude/longitude. " +
        "Useful when the user mentions a specific address, landmark, or neighbourhood.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: {
            type: "number",
            description: "Latitude of the search center (e.g. 48.8584 for Eiffel Tower)",
          },
          longitude: {
            type: "number",
            description: "Longitude of the search center (e.g. 2.2945 for Eiffel Tower)",
          },
          radius: {
            type: "number",
            description: "Search radius (1-100, default 20 KM)",
          },
          radiusUnit: {
            type: "string",
            enum: ["KM", "MILE"],
          },
          chainCodes: {
            type: "array",
            items: { type: "string" },
            description: "Hotel chain codes to filter by",
          },
          amenities: {
            type: "array",
            items: { type: "string" },
          },
          ratings: {
            type: "array",
            items: { type: "string" },
            description: "Star ratings to include e.g. ['4','5']",
          },
          hotelSource: {
            type: "string",
            enum: ["BEDBANK", "DIRECTCHAIN", "ALL"],
          },
        },
        required: ["latitude", "longitude"],
      },
    },
    {
      name: "get_hotel_offers",
      description:
        "Get live room availability and rates for specific hotels on given dates. " +
        "Automatically applies all negotiated/consortium rate codes (Virtuoso, Hyatt Privé, " +
        "Four Seasons Preferred Partner, Mandarin Oriental Fan Club, SLH, Preferred Hotels, etc.). " +
        "Pass hotel IDs from search_hotels_by_city (batches of 20 are handled automatically). " +
        "Returns available rooms, nightly rates, total price, cancellation policies, and " +
        "whether each rate is a negotiated rate.",
      inputSchema: {
        type: "object",
        properties: {
          hotelIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Amadeus hotel IDs from search_hotels_by_city (e.g. ['HILONFTW', 'MCPARLPL']). " +
              "Batches of 20 are handled automatically.",
          },
          checkInDate: {
            type: "string",
            description: "Check-in date in YYYY-MM-DD format",
          },
          checkOutDate: {
            type: "string",
            description: "Check-out date in YYYY-MM-DD format",
          },
          adults: {
            type: "number",
            description: "Number of adult guests (default 1)",
          },
          roomQuantity: {
            type: "number",
            description: "Number of rooms needed (default 1)",
          },
          currency: {
            type: "string",
            description: "Currency for pricing (e.g. USD, EUR, ILS, GBP). Defaults to hotel currency.",
          },
          priceRange: {
            type: "string",
            description: "Price filter as 'MIN-MAX' per night in the specified currency (e.g. '100-400')",
          },
          rateCodes: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional rate codes to include on top of the configured negotiated codes. " +
              "Known codes: APS=Virtuoso, PP6=Four Seasons, 3MF=Mandarin Oriental, " +
              "1HZ=Hyatt Privé, W9E=SLH, PR2=Preferred Hotels",
          },
          paymentPolicy: {
            type: "string",
            enum: ["GUARANTEE", "DEPOSIT", "NONE"],
            description: "Filter by required payment policy (default NONE = show all)",
          },
          boardType: {
            type: "string",
            enum: ["ROOM_ONLY", "BREAKFAST", "HALF_BOARD", "FULL_BOARD", "ALL_INCLUSIVE"],
            description: "Filter by board/meal plan",
          },
          lang: {
            type: "string",
            description: "Language code for descriptions (e.g. EN, FR, HE)",
          },
        },
        required: ["hotelIds", "checkInDate", "checkOutDate"],
      },
    },
    {
      name: "get_hotel_offer_details",
      description:
        "Get the complete details of a single hotel offer by its offer ID. " +
        "Use this before presenting a final booking option to confirm exact pricing, " +
        "room details, and full cancellation policy. " +
        "Offer IDs come from get_hotel_offers.",
      inputSchema: {
        type: "object",
        properties: {
          offerId: {
            type: "string",
            description: "The offer ID returned by get_hotel_offers",
          },
          lang: {
            type: "string",
            description: "Language code for descriptions (e.g. EN, FR, HE)",
          },
        },
        required: ["offerId"],
      },
    },
    {
      name: "get_hotel_content",
      description:
        "Fetch rich content for a hotel: images, description, contact details, and location. " +
        "Use this to enrich a hotel listing before presenting it to the user. " +
        "Hotel IDs come from search_hotels_by_city or get_hotel_offers.",
      inputSchema: {
        type: "object",
        properties: {
          hotelId: {
            type: "string",
            description: "Amadeus hotel ID (e.g. 'HILONFTW')",
          },
        },
        required: ["hotelId"],
      },
    },
    {
      name: "list_supplier_codes",
      description:
        "List all known negotiated rate / consortium program codes and their names. " +
        "Useful for explaining to the user what rates are being applied to their search.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
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
      // ---- search_hotels_by_city -------------------------------------------
      case "search_hotels_by_city": {
        const params = args as unknown as SearchHotelsByCity;
        if (!params.cityCode) {
          throw new McpError(ErrorCode.InvalidParams, "cityCode is required");
        }
        const hotels = await amadeus.searchHotelsByCity(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  environment: amadeus.getEnvironment(),
                  cityCode: params.cityCode.toUpperCase(),
                  count: hotels.length,
                  hotels: hotels.map((h) => ({
                    hotelId: h.hotelId,
                    name: h.name,
                    chainCode: h.chainCode,
                    rating: h.rating,
                    address: h.address,
                    geoCode: h.geoCode,
                    distance: h.distance,
                    amenities: h.amenities?.slice(0, 8),
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- search_hotels_by_geocode ----------------------------------------
      case "search_hotels_by_geocode": {
        const params = args as unknown as SearchHotelsByGeocode;
        if (params.latitude === undefined || params.longitude === undefined) {
          throw new McpError(ErrorCode.InvalidParams, "latitude and longitude are required");
        }
        const hotels = await amadeus.searchHotelsByGeocode(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  environment: amadeus.getEnvironment(),
                  center: { latitude: params.latitude, longitude: params.longitude },
                  count: hotels.length,
                  hotels: hotels.map((h) => ({
                    hotelId: h.hotelId,
                    name: h.name,
                    chainCode: h.chainCode,
                    rating: h.rating,
                    address: h.address,
                    geoCode: h.geoCode,
                    distance: h.distance,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- get_hotel_offers -----------------------------------------------
      case "get_hotel_offers": {
        const params = args as unknown as GetHotelOffers;
        if (!params.hotelIds?.length || !params.checkInDate || !params.checkOutDate) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "hotelIds, checkInDate, and checkOutDate are required"
          );
        }

        const offers = await amadeus.getHotelOffers(params);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  environment: amadeus.getEnvironment(),
                  checkIn: params.checkInDate,
                  checkOut: params.checkOutDate,
                  adults: params.adults ?? 1,
                  rooms: params.roomQuantity ?? 1,
                  negotiatedRateCodesApplied: amadeus.getDefaultSupplierCodes(),
                  hotelsSearched: params.hotelIds.length,
                  hotelsAvailable: offers.length,
                  results: offers.map((o) => ({
                    hotelId: o.hotel.hotelId,
                    hotelName: o.hotel.name,
                    rating: o.hotel.rating,
                    address: o.hotel.address,
                    offers: o.offers?.map((offer) => ({
                      offerId: offer.id,
                      rateCode: offer.rateCode,
                      supplierName: offer.supplierName,
                      isNegotiatedRate: offer.isNegotiatedRate,
                      boardType: offer.boardType,
                      room: offer.room.typeEstimated ?? offer.room.type,
                      roomDescription: offer.room.description?.text,
                      checkIn: offer.checkInDate,
                      checkOut: offer.checkOutDate,
                      checkInTime: offer.policies?.checkInOut?.checkIn,
                      checkOutTime: offer.policies?.checkInOut?.checkOut,
                      price: offer.price,
                      paymentType: offer.policies?.paymentType,
                      cancellation: offer.policies?.cancellation,
                    })),
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- get_hotel_offer_details ----------------------------------------
      case "get_hotel_offer_details": {
        const params = args as unknown as GetHotelOfferById;
        if (!params.offerId) {
          throw new McpError(ErrorCode.InvalidParams, "offerId is required");
        }
        const offer = await amadeus.getHotelOfferById(params);
        return {
          content: [{ type: "text", text: JSON.stringify(offer, null, 2) }],
        };
      }

      // ---- get_hotel_content ----------------------------------------------
      case "get_hotel_content": {
        const { hotelId } = args as { hotelId: string };
        if (!hotelId) {
          throw new McpError(ErrorCode.InvalidParams, "hotelId is required");
        }
        const content = await amadeus.getHotelContent(hotelId);
        if (!content) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "No content available for this hotel" }),
              },
            ],
          };
        }

        // Extract images from mediaScales (prefer F-scale ~300x200)
        const images: string[] = [];
        content.basic?.media?.forEach((m) => {
          const fScale = m.mediaScales?.find((s) => s.href.includes("/F.jpg"));
          const img = fScale ?? m.mediaScales?.[0];
          if (img) images.push(img.href);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  hotelId,
                  name: content.basic?.name,
                  rating: content.basic?.rating,
                  chainName: content.basic?.chainName,
                  brandName: content.basic?.brandName,
                  contact: content.basic?.contact?.[0],
                  location: content.basic?.location,
                  images: images.slice(0, 10),
                  description: content.basic?.media?.find((m) => m.description?.text)
                    ?.description?.text,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ---- list_supplier_codes --------------------------------------------
      case "list_supplier_codes": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  description:
                    "These rate codes are automatically injected into every hotel offer search " +
                    "to retrieve negotiated and consortium rates.",
                  activeCodesCount: amadeus.getDefaultSupplierCodes().length,
                  activeCodes: amadeus.getDefaultSupplierCodes(),
                  allKnownCodes: Object.entries(SUPPLIER_CODES).map(([code, info]) => ({
                    code,
                    name: info.name,
                    description: info.description,
                    active: amadeus.getDefaultSupplierCodes().includes(code),
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (isAxiosError(err)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Amadeus API error",
                status: err.response?.status,
                details: err.response?.data,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, (err as Error).message);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[amadeus-hotels] MCP server running on ${amadeus.getEnvironment()}. ` +
      `Rate codes: ${amadeus.getDefaultSupplierCodes().join(", ")}`
  );
}

main().catch((err) => {
  console.error("[amadeus-hotels] Startup error:", err);
  process.exit(1);
});
