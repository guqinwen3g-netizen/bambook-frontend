/**
 * Server-side geocoding: resolves coordinates from address data using
 * city-name lookup and postcode-prefix matching.
 *
 * This mirrors the client-side logic in utils/geoResolveService.ts.
 * Kept as a standalone module because the server tsconfig does not
 * include the frontend utils/ directory.
 */

// ─── City Coordinates ──────────────────────────
// Subset of the most common textile/garment industry cities.
// Full list lives in utils/geoUtils.ts on the frontend.

const CityCoordinates: Record<string, { lat: number; lon: number }> = {
    // China — East (Yangtze Delta)
    'Shanghai': { lat: 31.2304, lon: 121.4737 },
    'Hangzhou': { lat: 30.2741, lon: 120.1551 },
    'Ningbo': { lat: 29.8683, lon: 121.5440 },
    'Suzhou': { lat: 31.2990, lon: 120.5853 },
    'Zhangjiagang': { lat: 31.8756, lon: 120.5550 },
    'Wuxi': { lat: 31.4912, lon: 120.3119 },
    'Changzhou': { lat: 31.8106, lon: 119.9741 },
    'Nantong': { lat: 32.0641, lon: 120.8872 },
    'Shaoxing': { lat: 30.0791, lon: 120.4931 },
    'Jiaxing': { lat: 30.7527, lon: 120.7579 },
    'Jinhua': { lat: 29.0785, lon: 119.6474 },
    'Taizhou': { lat: 28.6563, lon: 121.4206 },
    'Yangzhou': { lat: 31.8106, lon: 119.9741 },
    'Huzhou': { lat: 30.8724, lon: 120.0886 },
    'Yiwu': { lat: 29.3051, lon: 120.0750 },
    // China — South (Pearl River Delta)
    'Shenzhen': { lat: 22.5431, lon: 114.0579 },
    'Guangzhou': { lat: 23.1291, lon: 113.2644 },
    'Dongguan': { lat: 23.0208, lon: 113.7518 },
    'Foshan': { lat: 23.0218, lon: 113.1219 },
    'Zhongshan': { lat: 22.5171, lon: 113.3926 },
    'Zhuhai': { lat: 22.2710, lon: 113.5767 },
    // China — North / Northeast
    'Beijing': { lat: 39.9042, lon: 116.4074 },
    'Tianjin': { lat: 39.3434, lon: 117.3616 },
    'Qingdao': { lat: 36.0671, lon: 120.3826 },
    'Dalian': { lat: 38.9140, lon: 121.6147 },
    'Jinan': { lat: 36.6512, lon: 116.9972 },
    // China — Central / Southwest
    'Wuhan': { lat: 30.5928, lon: 114.3055 },
    'Chengdu': { lat: 30.5728, lon: 104.0668 },
    'Chongqing': { lat: 29.4316, lon: 106.9123 },
    'Xiamen': { lat: 24.4798, lon: 118.0894 },
    'Fuzhou': { lat: 26.0745, lon: 119.2965 },
    'Quanzhou': { lat: 24.8741, lon: 118.6757 },
    'Changsha': { lat: 28.2282, lon: 112.9388 },
    'Nanning': { lat: 22.8170, lon: 108.3665 },
    // East Asia
    'Tokyo': { lat: 35.6762, lon: 139.6503 },
    'Osaka': { lat: 34.6937, lon: 135.5023 },
    'Seoul': { lat: 37.5665, lon: 126.9780 },
    'Busan': { lat: 35.1796, lon: 129.0756 },
    // Southeast Asia
    'Ho Chi Minh City': { lat: 10.8231, lon: 106.6297 },
    'Hanoi': { lat: 21.0285, lon: 105.8542 },
    'Bangkok': { lat: 13.7563, lon: 100.5018 },
    'Jakarta': { lat: -6.2088, lon: 106.8456 },
    'Phnom Penh': { lat: 11.5564, lon: 104.9282 },
    'Yangon': { lat: 16.8661, lon: 96.1951 },
    'Manila': { lat: 14.5995, lon: 120.9842 },
    'Kuala Lumpur': { lat: 3.1390, lon: 101.6869 },
    'Singapore': { lat: 1.3521, lon: 103.8198 },
    'Chittagong': { lat: 22.3569, lon: 91.7832 },
    // South Asia
    'Dhaka': { lat: 23.8103, lon: 90.4125 },
    'Mumbai': { lat: 19.0760, lon: 72.8777 },
    'New Delhi': { lat: 28.6139, lon: 77.2090 },
    'Chennai': { lat: 13.0827, lon: 80.2707 },
    'Karachi': { lat: 24.8607, lon: 67.0011 },
    'Lahore': { lat: 31.5204, lon: 74.3587 },
    'Colombo': { lat: 6.9271, lon: 79.8612 },
    // Europe
    'London': { lat: 51.5074, lon: -0.1278 },
    'Paris': { lat: 48.8566, lon: 2.3522 },
    'Amsterdam': { lat: 52.3676, lon: 4.9041 },
    'Rotterdam': { lat: 51.9244, lon: 4.4777 },
    'Milan': { lat: 45.4642, lon: 9.1900 },
    'Florence': { lat: 43.7696, lon: 11.2558 },
    'Munich': { lat: 48.1351, lon: 11.5820 },
    'Frankfurt': { lat: 50.1109, lon: 8.6821 },
    'Essen': { lat: 51.4556, lon: 7.0116 },
    'Hamburg': { lat: 53.5511, lon: 9.9937 },
    'Berlin': { lat: 52.5200, lon: 13.4050 },
    'Zurich': { lat: 47.3769, lon: 8.5417 },
    'Istanbul': { lat: 41.0082, lon: 28.9784 },
    'Barcelona': { lat: 41.3874, lon: 2.1686 },
    'Madrid': { lat: 40.4168, lon: -3.7038 },
    'Lisbon': { lat: 38.7223, lon: -9.1393 },
    'Porto': { lat: 41.1579, lon: -8.6291 },
    'Stockholm': { lat: 59.3293, lon: 18.0686 },
    'Copenhagen': { lat: 55.6761, lon: 12.5683 },
    // Americas
    'New York': { lat: 40.7128, lon: -74.0060 },
    'Los Angeles': { lat: 34.0522, lon: -118.2437 },
    'Chicago': { lat: 41.8781, lon: -87.6298 },
    'Miami': { lat: 25.7617, lon: -80.1918 },
    'San Francisco': { lat: 37.7749, lon: -122.4194 },
    'Toronto': { lat: 43.6532, lon: -79.3832 },
    'Vancouver': { lat: 49.2827, lon: -123.1207 },
    'Montreal': { lat: 45.5017, lon: -73.5673 },
    'Mexico City': { lat: 19.4326, lon: -99.1332 },
    'Sao Paulo': { lat: -23.5505, lon: -46.6333 },
    'Rio de Janeiro': { lat: -22.9068, lon: -43.1729 },
    'Buenos Aires': { lat: -34.6037, lon: -58.3816 },
    'Lima': { lat: -12.0464, lon: -77.0428 },
    'Bogota': { lat: 4.7110, lon: -74.0721 },
    // Africa
    'Cairo': { lat: 30.0444, lon: 31.2357 },
    'Alexandria': { lat: 31.2001, lon: 29.9187 },
    'Addis Ababa': { lat: 9.0331, lon: 38.7444 },
    'Nairobi': { lat: -1.2921, lon: 36.8219 },
    'Lagos': { lat: 6.5244, lon: 3.3792 },
    'Casablanca': { lat: 33.5731, lon: -7.5898 },
    'Johannesburg': { lat: -26.2041, lon: 28.0473 },
    'Cape Town': { lat: -33.9249, lon: 18.4241 },
    'Accra': { lat: 5.6037, lon: -0.1870 },
    // Middle East
    'Dubai': { lat: 25.2048, lon: 55.2708 },
};

// ─── Postcode Prefixes ──────────────────────────
// Same structure as utils/postcodeCoordinates.ts

interface PostcodeEntry {
    prefix: string;
    lat: number;
    lon: number;
}

const PostcodePrefixes: Record<string, PostcodeEntry[]> = {
    CN: [
        { prefix: '200', lat: 31.23, lon: 121.47 },
        { prefix: '510', lat: 23.13, lon: 113.26 },
        { prefix: '511', lat: 23.13, lon: 113.26 },
        { prefix: '518', lat: 22.55, lon: 114.06 },
        { prefix: '310', lat: 30.27, lon: 120.16 },
        { prefix: '311', lat: 30.27, lon: 120.16 },
        { prefix: '315', lat: 29.87, lon: 121.54 },
        { prefix: '215', lat: 31.30, lon: 120.59 },
        { prefix: '214', lat: 31.49, lon: 120.31 },
        { prefix: '213', lat: 31.81, lon: 119.97 },
        { prefix: '226', lat: 32.06, lon: 120.89 },
        { prefix: '312', lat: 30.08, lon: 120.49 },
        { prefix: '321', lat: 29.08, lon: 119.65 },
        { prefix: '100', lat: 39.90, lon: 116.41 },
        { prefix: '101', lat: 39.90, lon: 116.41 },
        { prefix: '300', lat: 39.34, lon: 117.36 },
        { prefix: '266', lat: 36.07, lon: 120.38 },
        { prefix: '116', lat: 38.91, lon: 121.61 },
        { prefix: '361', lat: 24.48, lon: 118.09 },
        { prefix: '350', lat: 26.07, lon: 119.30 },
        { prefix: '430', lat: 30.59, lon: 114.31 },
        { prefix: '610', lat: 30.57, lon: 104.07 },
        { prefix: '400', lat: 29.43, lon: 106.91 },
        { prefix: '523', lat: 23.02, lon: 113.75 },
        { prefix: '528', lat: 23.02, lon: 113.12 },
    ],
    BD: [
        { prefix: '1000', lat: 23.81, lon: 90.41 },
        { prefix: '1200', lat: 23.81, lon: 90.41 },
        { prefix: '1300', lat: 23.81, lon: 90.41 },
        { prefix: '4000', lat: 22.36, lon: 91.78 },
        { prefix: '3000', lat: 24.37, lon: 88.60 },
        { prefix: '2200', lat: 24.90, lon: 91.87 },
    ],
    VN: [
        { prefix: '700', lat: 10.82, lon: 106.63 },
        { prefix: '710', lat: 10.82, lon: 106.63 },
        { prefix: '100', lat: 21.03, lon: 105.85 },
        { prefix: '110', lat: 21.03, lon: 105.85 },
    ],
    IN: [
        { prefix: '400', lat: 19.08, lon: 72.88 },
        { prefix: '110', lat: 28.61, lon: 77.21 },
        { prefix: '560', lat: 12.97, lon: 77.59 },
        { prefix: '600', lat: 13.08, lon: 80.27 },
        { prefix: '700', lat: 22.57, lon: 88.36 },
        { prefix: '380', lat: 23.02, lon: 72.57 },
        { prefix: '500', lat: 17.39, lon: 78.49 },
    ],
    US: [
        { prefix: '100', lat: 40.71, lon: -74.01 },
        { prefix: '900', lat: 34.05, lon: -118.24 },
        { prefix: '600', lat: 41.88, lon: -87.63 },
        { prefix: '770', lat: 29.76, lon: -95.37 },
        { prefix: '330', lat: 25.76, lon: -80.19 },
        { prefix: '940', lat: 37.77, lon: -122.42 },
        { prefix: '750', lat: 32.78, lon: -96.80 },
        { prefix: '303', lat: 33.75, lon: -84.39 },
    ],
    GB: [
        { prefix: 'E', lat: 51.53, lon: -0.04 },
        { prefix: 'W', lat: 51.51, lon: -0.14 },
        { prefix: 'SW', lat: 51.47, lon: -0.17 },
        { prefix: 'SE', lat: 51.48, lon: -0.08 },
        { prefix: 'M', lat: 53.48, lon: -2.24 },
        { prefix: 'B', lat: 52.48, lon: -1.90 },
    ],
    DE: [
        { prefix: '101', lat: 52.52, lon: 13.41 },
        { prefix: '803', lat: 48.14, lon: 11.58 },
        { prefix: '200', lat: 53.55, lon: 10.00 },
        { prefix: '603', lat: 50.11, lon: 8.68 },
        { prefix: '451', lat: 51.46, lon: 7.01 },
    ],
    IT: [
        { prefix: '201', lat: 45.46, lon: 9.19 },
        { prefix: '001', lat: 41.90, lon: 12.50 },
        { prefix: '501', lat: 43.77, lon: 11.26 },
    ],
    FR: [
        { prefix: '750', lat: 48.86, lon: 2.35 },
        { prefix: '690', lat: 45.76, lon: 4.84 },
        { prefix: '130', lat: 43.30, lon: 5.37 },
    ],
    CA: [
        { prefix: 'M', lat: 43.65, lon: -79.38 },
        { prefix: 'V', lat: 49.28, lon: -123.12 },
        { prefix: 'H', lat: 45.50, lon: -73.57 },
    ],
    BR: [
        { prefix: '010', lat: -23.55, lon: -46.63 },
        { prefix: '200', lat: -22.91, lon: -43.17 },
    ],
    MX: [
        { prefix: '060', lat: 19.43, lon: -99.13 },
        { prefix: '440', lat: 20.67, lon: -103.35 },
        { prefix: '640', lat: 25.67, lon: -100.31 },
    ],
};

// ─── Country inference ──────────────────────────

function inferCountry(address?: string, postcode?: string): string | undefined {
    if (address) {
        const u = address.toUpperCase();
        if (u.includes('CHINA') || u.includes('P.R.C') || u.includes('PRC')) return 'CN';
        if (u.includes('BANGLADESH')) return 'BD';
        if (u.includes('VIETNAM') || u.includes('VIET NAM')) return 'VN';
        if (u.includes('INDIA')) return 'IN';
        if (u.includes('PAKISTAN')) return 'PK';
        if (u.includes('TURKEY') || u.includes('TÜRKIYE')) return 'TR';
        if (u.includes('UNITED KINGDOM') || u.includes('U.K.') || u.includes(', UK')) return 'GB';
        if (u.includes('UNITED STATES') || u.includes('U.S.A.') || u.includes(', USA')) return 'US';
        if (u.includes('GERMANY') || u.includes('DEUTSCHLAND')) return 'DE';
        if (u.includes('ITALY') || u.includes('ITALIA')) return 'IT';
        if (u.includes('FRANCE')) return 'FR';
        if (u.includes('CANADA')) return 'CA';
        if (u.includes('JAPAN')) return 'JP';
        if (u.includes('KOREA') || u.includes('SOUTH KOREA')) return 'KR';
        if (u.includes('BRAZIL') || u.includes('BRASIL')) return 'BR';
        if (u.includes('MEXICO') || u.includes('MÉXICO')) return 'MX';
    }
    if (postcode) {
        const pc = postcode.trim();
        if (/^\d{6}$/.test(pc)) {
            const first = pc[0];
            if (['1', '2', '3', '4', '5', '6', '7'].includes(first)) return 'CN';
        }
        if (/^\d{4}$/.test(pc)) return 'BD';
        if (/^[A-Z]\d[A-Z]/.test(pc)) return 'CA';
        if (/^[A-Z]{1,2}\d/.test(pc) && pc.length >= 5) return 'GB';
    }
    return undefined;
}

// ─── Postcode resolution ───────────────────────

function resolvePostcode(postcode: string, countryCode: string): { lat: number; lon: number } | null {
    const entries = PostcodePrefixes[countryCode.toUpperCase()];
    if (!entries || !postcode) return null;
    const pc = postcode.trim();
    const sorted = [...entries].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const entry of sorted) {
        if (pc.startsWith(entry.prefix)) {
            return { lat: entry.lat, lon: entry.lon };
        }
    }
    return null;
}

// ─── City extraction from address text ─────────

function extractCityFromText(text: string): string | null {
    if (!text) return null;
    const keys = Object.keys(CityCoordinates).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) return key;
    }
    return null;
}

// ─── Main resolver ──────────────────────────────

export interface ResolvedCoordinates {
    lat: number;
    lng: number;
    source: 'city' | 'postcode' | 'address_keyword' | 'fallback';
}

/**
 * Resolve coordinates from a Relation's address data.
 * Called during toDbPayload when coordinatesLat/coordinatesLng are empty.
 */
export function resolveRelationCoordinates(input: {
    officialAddress?: string;
    factoryAddresses?: string[];
    shipToAddresses?: Array<{ city?: string; address?: string }>;
    shippingAddress?: string;
    country?: string;
}): ResolvedCoordinates | null {
    // Extract best available city/address info
    let city: string | undefined;
    let address: string | undefined;
    let country: string | undefined;

    if (input.shipToAddresses && input.shipToAddresses.length > 0) {
        const primary = input.shipToAddresses[0];
        city = primary.city?.trim();
        address = primary.address?.trim();
    }
    if (!city && input.officialAddress) {
        address = input.officialAddress.trim();
    }
    if (!city && input.factoryAddresses && input.factoryAddresses.length > 0) {
        address = (input.factoryAddresses[0] || '').trim();
    }
    if (!city && !address && input.shippingAddress) {
        address = input.shippingAddress.trim();
    }
    country = input.country?.trim();

    // Layer 1: city name match
    if (city) {
        if (CityCoordinates[city]) {
            const c = CityCoordinates[city];
            return { lat: c.lat, lng: c.lon, source: 'city' };
        }
        const keys = Object.keys(CityCoordinates);
        const partial = keys.find(key => city!.includes(key));
        if (partial) {
            const c = CityCoordinates[partial];
            return { lat: c.lat, lng: c.lon, source: 'city' };
        }
    }

    // Layer 2: address keyword extraction (before postcode — city match is more accurate)
    const addressTexts = [address, city].filter(Boolean).join(' ');
    if (addressTexts) {
        const extracted = extractCityFromText(addressTexts);
        if (extracted) {
            const c = CityCoordinates[extracted];
            return { lat: c.lat, lng: c.lon, source: 'address_keyword' };
        }
    }

    // Layer 3: country inference from address
    const inferredCountry = country || inferCountry(address);

    // Layer 4: postcode match (requires country)
    // Try to extract postcode from address text
    const postcode = extractPostcode(address || '', inferredCountry);
    if (postcode && inferredCountry) {
        const pc = resolvePostcode(postcode, inferredCountry);
        if (pc) {
            return { lat: pc.lat, lng: pc.lon, source: 'postcode' };
        }
    }

    // No resolution possible
    return null;
}

/**
 * Try to extract a postcode from address text based on country patterns.
 */
function extractPostcode(address: string, country?: string): string | undefined {
    if (!address) return undefined;

    // CN: 6-digit postcode
    if (country === 'CN') {
        const m = address.match(/\b(\d{6})\b/);
        if (m) return m[1];
    }

    // BD: 4-digit postcode
    if (country === 'BD') {
        const m = address.match(/\b(\d{4})\b/);
        if (m) return m[1];
    }

    // US: 5-digit ZIP
    if (country === 'US') {
        const m = address.match(/\b(\d{5})\b/);
        if (m) return m[1];
    }

    // GB: UK-style postcode (e.g. "SW1A 1AA")
    if (country === 'GB') {
        const m = address.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
        if (m) return m[1];
    }

    // DE: 5-digit PLZ
    if (country === 'DE') {
        const m = address.match(/\b(\d{5})\b/);
        if (m) return m[1];
    }

    // Generic: try 5-6 digit number as postcode
    const m = address.match(/\b(\d{5,6})\b/);
    return m ? m[1] : undefined;
}
