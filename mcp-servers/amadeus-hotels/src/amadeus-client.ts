import axios, { AxiosInstance, isAxiosError } from "axios";
import {
  AmadeusTokenResponse,
  HotelSearchResult,
  HotelOffer,
  HotelContent,
  SearchHotelsByCity,
  GetHotelOffers,
  GetHotelOfferById,
  SearchHotelsByGeocode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Negotiated / consortium rate codes known to the platform.
// These map Amadeus rate codes to their program names so the AI can surface
// them meaningfully to the user.
// ---------------------------------------------------------------------------
// Luxury consortium rate codes - auto-injected into every offer search to
// surface negotiated rates when available.  The Amadeus v3 API allows up to
// ~6 rate codes per request, so we keep only the consortium programs here.
export const SUPPLIER_CODES: Record<string, { name: string; description: string; benefits: string[] }> = {
  APS: {
    name: "Virtuoso",
    description: "Exclusive luxury travel network - VIP amenities and upgrades",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Early check-in / late checkout (subject to availability)",
      "USD 100 hotel credit per stay",
      "Complimentary Wi-Fi",
    ],
  },
  PP6: {
    name: "Four Seasons Preferred Partner",
    description: "Exclusive benefits at Four Seasons properties",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Late checkout (subject to availability)",
      "USD 100 hotel credit per stay",
      "Complimentary Wi-Fi",
    ],
  },
  "3MF": {
    name: "Mandarin Oriental Fan Club",
    description: "Fan Club benefits at Mandarin Oriental properties worldwide",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Early check-in / late checkout (subject to availability)",
      "USD 100 hotel credit per stay",
      "Complimentary pressing of two garments",
    ],
  },
  "1HZ": {
    name: "Hyatt Prive",
    description: "Exclusive amenities at Hyatt Hotels via Prive program",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Early check-in / late checkout (subject to availability)",
      "USD 100 property credit per stay",
      "Complimentary Wi-Fi",
    ],
  },
  W9E: {
    name: "SLH (Small Luxury Hotels)",
    description: "Boutique luxury experiences through Small Luxury Hotels of the World",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Late checkout (subject to availability)",
      "USD 100 hotel credit per stay",
      "VIP recognition",
    ],
  },
  PR2: {
    name: "Preferred Hotels & Resorts",
    description: "Preferred Hotels iPrefer benefits and amenities",
    benefits: [
      "Room upgrade at check-in (subject to availability)",
      "Daily breakfast for two",
      "Late checkout (subject to availability)",
      "USD 100 property credit per stay",
      "iPrefer loyalty points",
    ],
  },
};

// ---------------------------------------------------------------------------
// Amadeus Enterprise client
// ---------------------------------------------------------------------------
export class AmadeusClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly guestOfficeId: string | undefined;
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly defaultSupplierCodes: string[];

  private http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    const isTest = process.env.AMADEUS_ENV === "test";

    // Env vars:
    //   Production: AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET
    //   UAT/Test:   AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, AMADEUS_GUEST_OFFICE_ID
    //
    // Set AMADEUS_ENV=test to use Enterprise UAT (test.travel.api.amadeus.com)
    // Leave unset / set to "production" for live Enterprise API (travel.api.amadeus.com)
    this.clientId = process.env.AMADEUS_CLIENT_ID ?? "";
    this.clientSecret = process.env.AMADEUS_CLIENT_SECRET ?? "";
    this.guestOfficeId = process.env.AMADEUS_GUEST_OFFICE_ID;

    // Enterprise URLs:
    //   Production:     https://travel.api.amadeus.com
    //   Enterprise UAT: https://test.travel.api.amadeus.com
    // Note: https://api.amadeus.com is the Self-Service API – do NOT use it for Enterprise.
    this.baseUrl = isTest
      ? "https://test.travel.api.amadeus.com"
      : "https://travel.api.amadeus.com";
    this.authUrl = `${this.baseUrl}/v1/security/oauth2/token`;

    // Supplier/rate codes to automatically include in every offer search.
    // Comma-separated list in AMADEUS_RATE_CODES env var, or falls back to
    // all known program codes.
    if (process.env.AMADEUS_RATE_CODES) {
      this.defaultSupplierCodes = process.env.AMADEUS_RATE_CODES
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    } else {
      this.defaultSupplierCodes = Object.keys(SUPPLIER_CODES);
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET environment variables are required"
      );
    }

    this.http = axios.create({ baseURL: this.baseUrl });

    // Auto-attach bearer token and Ama-Client-Ref to every API request.
    // The Ama-Client-Ref header is required by the Amadeus Enterprise API
    // gateway for request routing and correlation.
    this.http.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      if (!config.headers["Ama-Client-Ref"]) {
        config.headers["Ama-Client-Ref"] = AmadeusClient.generateRef();
      }
      return config;
    });
  }

  // ---- Authentication -------------------------------------------------------

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const params: Record<string, string> = {
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };

    // Enterprise UAT requires the office/PCC ID in the token request
    if (this.guestOfficeId) {
      params.guest_office_id = this.guestOfficeId;
    }

    const response = await axios.post<AmadeusTokenResponse>(
      this.authUrl,
      new URLSearchParams(params).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Ama-Client-Ref": AmadeusClient.generateRef(),
        },
      }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = now + response.data.expires_in * 1000;
    return this.accessToken;
  }

  // ---- Hotel List -----------------------------------------------------------

  /**
   * Search hotels by IATA city code.
   * Returns hotel identifiers – call getHotelOffers() to get live pricing.
   */
  async searchHotelsByCity(params: SearchHotelsByCity): Promise<HotelSearchResult[]> {
    const query: Record<string, string | number> = {
      cityCode: params.cityCode.toUpperCase(),
      radius: Math.min(Math.max(1, params.radius ?? 20), 100),
      radiusUnit: params.radiusUnit ?? "KM",
      hotelSource: params.hotelSource ?? "ALL",
    };

    if (params.chainCodes?.length) query.chainCodes = params.chainCodes.join(",");
    if (params.amenities?.length) query.amenities = params.amenities.join(",");
    if (params.ratings?.length) query.ratings = params.ratings.join(",");

    const response = await this.http.get<{ data: HotelSearchResult[] }>(
      "/v1/reference-data/locations/hotels/by-city",
      { params: query }
    );
    return response.data.data ?? [];
  }

  /**
   * Search hotels near a geographic coordinate.
   */
  async searchHotelsByGeocode(
    params: SearchHotelsByGeocode
  ): Promise<HotelSearchResult[]> {
    const query: Record<string, string | number> = {
      latitude: params.latitude,
      longitude: params.longitude,
      radius: Math.min(Math.max(1, params.radius ?? 20), 100),
      radiusUnit: params.radiusUnit ?? "KM",
      hotelSource: params.hotelSource ?? "ALL",
    };

    if (params.chainCodes?.length) query.chainCodes = params.chainCodes.join(",");
    if (params.amenities?.length) query.amenities = params.amenities.join(",");
    if (params.ratings?.length) query.ratings = params.ratings.join(",");

    const response = await this.http.get<{ data: HotelSearchResult[] }>(
      "/v1/reference-data/locations/hotels/by-geocode",
      { params: query }
    );
    return response.data.data ?? [];
  }

  // ---- Hotel Offers (availability + pricing) --------------------------------

  /**
   * Get live availability and rates for up to 20 hotels.
   * Automatically batches if more than 20 IDs are provided.
   * Automatically injects all configured supplier/rate codes.
   */
  async getHotelOffers(params: GetHotelOffers): Promise<HotelOffer[]> {
    const BATCH_SIZE = 20;
    const allIds = params.hotelIds;
    const batches: string[][] = [];

    for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
      batches.push(allIds.slice(i, i + BATCH_SIZE));
    }

    // Merge caller-provided codes with defaults; deduplicate.
    // The Amadeus v3 API limits rateCodes to ~6 items per request.
    // We prioritize caller-provided codes, then fill with defaults.
    const MAX_RATE_CODES = 6;
    const rateCodes = [
      ...new Set([
        ...(params.rateCodes ?? []),
        ...this.defaultSupplierCodes,
      ]),
    ].slice(0, MAX_RATE_CODES);

    const allResults: HotelOffer[] = [];

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      try {
        const requestParams: Record<string, string> = {
          hotelIds: batch.join(","),
          adults: String(params.adults ?? 1),
          checkInDate: params.checkInDate,
          checkOutDate: params.checkOutDate,
          roomQuantity: String(params.roomQuantity ?? 1),
          paymentPolicy: params.paymentPolicy ?? "GUARANTEE",
          includeClosed: "false",
          view: "FULL",
          bestRateOnly: "false", // Return all available rates, not just the cheapest
        };

        if (params.currency) requestParams.currency = params.currency;
        if (params.priceRange) requestParams.priceRange = params.priceRange;
        if (params.boardType) requestParams.boardType = params.boardType;
        if (params.lang) requestParams.lang = params.lang;
        if (rateCodes.length) requestParams.rateCodes = rateCodes.join(",");

        const response = await this.http.get<{ data: HotelOffer[] }>(
          "/v3/shopping/hotel-offers",
          { params: requestParams }
        );

        if (response.data?.data?.length) {
          // Enrich each offer with supplier name from SUPPLIER_CODES lookup
          const enriched = response.data.data.map((hotel) => ({
            ...hotel,
            offers: hotel.offers?.map((offer) => {
              const code = offer.rateCode?.trim() ?? "";
              const supplierInfo = SUPPLIER_CODES[code];
              return {
                ...offer,
                supplierName: supplierInfo?.name,
                isNegotiatedRate: Boolean(supplierInfo),
              };
            }),
          }));

          allResults.push(
            ...enriched.filter((h) => h.available && (h.offers?.length ?? 0) > 0)
          );
        }
      } catch (err) {
        // Log batch error but continue processing remaining batches
        if (isAxiosError(err)) {
          console.error(
            `[amadeus] Batch ${batchIdx + 1} error:`,
            err.response?.data ?? err.message
          );
        }
      }

      // Small delay between batches to avoid rate limiting
      if (batchIdx < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    return allResults;
  }

  /**
   * Get full details of a specific hotel offer by its offer ID.
   */
  async getHotelOfferById(params: GetHotelOfferById): Promise<HotelOffer> {
    const query: Record<string, string> = {};
    if (params.lang) query.lang = params.lang;

    const response = await this.http.get<{ data: HotelOffer }>(
      `/v3/shopping/hotel-offers/${params.offerId}`,
      { params: query }
    );
    return response.data.data;
  }

  // ---- Hotel Content --------------------------------------------------------

  /**
   * Fetch rich content for a hotel: images, description, contact, location.
   * Uses the Enterprise hotel content endpoint.
   */
  async getHotelContent(hotelId: string): Promise<HotelContent | null> {
    try {
      const response = await this.http.get<{ data: HotelContent }>(
        `/v1/reference-data/locations/hotels/${hotelId}`
      );
      return response.data?.data ?? null;
    } catch (err) {
      // Content is optional – return null rather than throwing
      if (isAxiosError(err)) {
        console.error(`[amadeus] Hotel content unavailable for ${hotelId}:`, err.message);
      }
      return null;
    }
  }

  // ---- Helpers --------------------------------------------------------------

  /**
   * Generate a unique Ama-Client-Ref value.
   * Format: HADASSIM-{timestamp}-{random}
   * Required by the Amadeus Enterprise API gateway on every request.
   */
  static generateRef(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 15);
    return `HADASSIM-${ts}-${rand}`;
  }

  getDefaultSupplierCodes(): string[] {
    return this.defaultSupplierCodes;
  }

  getEnvironment(): string {
    return process.env.AMADEUS_ENV === "test" ? "UAT (test.travel.api.amadeus.com)" : "Production (travel.api.amadeus.com)";
  }
}
