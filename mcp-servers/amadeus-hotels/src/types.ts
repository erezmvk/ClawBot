// Amadeus Enterprise API – TypeScript type definitions

export interface AmadeusTokenResponse {
  type: string;
  username: string;
  application_name: string;
  client_id: string;
  token_type: string;
  access_token: string;
  expires_in: number;
  state: string;
  scope: string;
}

// ---- Hotel List (reference-data) ------------------------------------------

export interface HotelSearchResult {
  hotelId: string;
  name: string;
  chainCode?: string;
  iataCode?: string;
  dupeId?: string;
  address?: {
    lines?: string[];
    postalCode?: string;
    cityName?: string;
    countryCode?: string;
    stateCode?: string;
  };
  geoCode?: {
    latitude: number;
    longitude: number;
  };
  distance?: {
    value: number;
    unit: string;
  };
  amenities?: string[];
  rating?: string;
  lastUpdate?: string;
}

// ---- Hotel Content (reference-data/locations/hotels/{id}) -----------------

export interface HotelContent {
  hotelId?: string;
  basic?: {
    name?: string;
    rating?: string;
    chainName?: string;
    brandName?: string;
    contact?: Array<{
      purpose?: string;
      phones?: Array<{ category?: string; countryCode?: string; number?: string }>;
      emails?: string[];
      urls?: string[];
    }>;
    location?: {
      address?: {
        line1?: string;
        line2?: string;
        cityName?: string;
        countryCode?: string;
        postalCode?: string;
        stateCode?: string;
      };
      geoCode?: { latitude: number; longitude: number };
    };
    media?: Array<{
      category?: string;
      description?: { text?: string; lang?: string };
      mediaScales?: Array<{ href: string; width?: number; height?: number }>;
    }>;
  };
}

// ---- Hotel Offers (shopping/hotel-offers) ----------------------------------

export interface HotelOffer {
  type?: string;
  hotel: {
    hotelId: string;
    name: string;
    rating?: string;
    cityCode?: string;
    latitude?: number;
    longitude?: number;
    hotelDistance?: { distance: number; distanceUnit: string };
    address?: {
      lines: string[];
      postalCode?: string;
      cityName?: string;
      countryCode?: string;
    };
    contact?: { phone?: string; fax?: string; email?: string };
    description?: { text: string; lang: string };
    amenities?: string[];
    media?: Array<{ uri: string; category: string }>;
  };
  available: boolean;
  offers?: Array<{
    id: string;
    checkInDate: string;
    checkOutDate: string;
    rateCode?: string;
    // Enriched client-side fields (not from API)
    supplierName?: string;
    isNegotiatedRate?: boolean;
    rateFamilyEstimated?: { code: string; type: string };
    category?: string;
    description?: { text: string; lang: string };
    commission?: {
      percentage?: string;
      amount?: string;
      description?: { lang: string; text: string };
    };
    boardType?: string;
    room: {
      type?: string;
      typeEstimated?: {
        category?: string;
        beds?: number;
        bedType?: string;
      };
      description?: { text: string; lang: string };
    };
    guests: { adults: number };
    price: {
      currency: string;
      base?: string;
      total: string;
      taxes?: Array<{
        code: string;
        pricingFrequency: string;
        pricingMode: string;
        percentage?: string;
        amount?: string;
        included: boolean;
      }>;
      variations?: {
        average?: { base?: string; total?: string };
        changes?: Array<{
          startDate: string;
          endDate: string;
          base?: string;
          total?: string;
        }>;
      };
    };
    policies?: {
      paymentType?: string;
      cancellation?: {
        type?: string;
        deadline?: string;
        description?: { text: string; lang: string };
      };
      checkInOut?: {
        checkIn?: string;
        checkInMinTime?: string;
        checkInMaxTime?: string;
        checkOut?: string;
      };
    };
    self?: string;
  }>;
  self?: string;
}

// ---- Tool input parameter types -------------------------------------------

export interface SearchHotelsByCity {
  cityCode: string;
  radius?: number;
  radiusUnit?: "KM" | "MILE";
  chainCodes?: string[];
  amenities?: string[];
  ratings?: string[];
  hotelSource?: "BEDBANK" | "DIRECTCHAIN" | "ALL";
}

export interface GetHotelOffers {
  hotelIds: string[];
  checkInDate: string;
  checkOutDate: string;
  adults?: number;
  roomQuantity?: number;
  currency?: string;
  priceRange?: string;
  rateCodes?: string[];
  paymentPolicy?: "GUARANTEE" | "DEPOSIT" | "NONE";
  boardType?: "ROOM_ONLY" | "BREAKFAST" | "HALF_BOARD" | "FULL_BOARD" | "ALL_INCLUSIVE";
  lang?: string;
}

export interface GetHotelOfferById {
  offerId: string;
  lang?: string;
}

export interface SearchHotelsByGeocode {
  latitude: number;
  longitude: number;
  radius?: number;
  radiusUnit?: "KM" | "MILE";
  chainCodes?: string[];
  amenities?: string[];
  ratings?: string[];
  hotelSource?: "BEDBANK" | "DIRECTCHAIN" | "ALL";
}
