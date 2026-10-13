/**
 * Unified geocoding service: resolves coordinates from structured address data
 * using a layered strategy (city → postcode → address keyword；未命中返回 null)。
 *
 * This is a pure function module — no API calls, no side effects.
 * Used both on the client (preview) and as the algorithm reference for
 * server-side persistence.
 */

import { CityCoordinates } from './geoUtils';
import { resolvePostcode } from './postcodeCoordinates';

// ─── Types ──────────────────────────────────────

export interface AddressInput {
    /** City name (e.g. "Shanghai", "Dhaka") */
    city?: string;
    /** Postal / ZIP code (e.g. "200020", "SW1A 1AA") */
    postcode?: string;
    /** ISO-3166-1 alpha-2 country code (e.g. "CN", "BD", "US") */
    country?: string;
    /** Free-text address (searched for city keywords) */
    address?: string;
}

export type ResolveSource =
    | 'existing'     // coordinates already present — no resolution needed
    | 'city'         // matched via CityCoordinates
    | 'postcode'     // matched via postcode prefix database
    | 'address_keyword'; // extracted city keyword from address text
    // 注：'fallback'（哈希伪随机坐标）已退役——无法解析时 resolveCoordinates 返回 null，
    // 不写假坐标入库。坐标真源（Relation 挂 lat/lon）待 v1.1 立项。

export interface ResolvedCoordinates {
    lat: number;
    lng: number;
    /** How the coordinates were obtained (useful for UI display). */
    source: ResolveSource;
    /** Human-readable label for the match (city name, postcode area, etc.). */
    label?: string;
}

// ─── Helpers ────────────────────────────────────

/**
 * Extract a potential city name from a free-text address string.
 * Tries the longest CityCoordinates key that appears as a word in the text.
 */
function extractCityFromText(text: string): { city: string; key: string } | null {
    if (!text) return null;
    // Sort keys by length descending so "Ho Chi Minh City" beats "City"
    const keys = Object.keys(CityCoordinates).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        // Case-insensitive word-boundary match
        const re = new RegExp(`\\b${escapeRegex(key)}\\b`, 'i');
        if (re.test(text)) {
            return { city: key, key };
        }
    }
    return null;
}

/** Escape special regex chars in a string. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Country-code heuristics ────────────────────

/**
 * Attempt to infer ISO country code from address text or postcode format.
 * Best-effort heuristic — not exhaustive.
 */
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
        if (u.includes('SPAIN') || u.includes('ESPAÑA')) return 'ES';
        if (u.includes('PORTUGAL')) return 'PT';
        if (u.includes('BRAZIL') || u.includes('BRASIL')) return 'BR';
        if (u.includes('MEXICO') || u.includes('MÉXICO')) return 'MX';
        if (u.includes('CANADA')) return 'CA';
        if (u.includes('JAPAN')) return 'JP';
        if (u.includes('KOREA') || u.includes('SOUTH KOREA')) return 'KR';
        if (u.includes('INDONESIA')) return 'ID';
        if (u.includes('THAILAND')) return 'TH';
        if (u.includes('CAMBODIA')) return 'KH';
        if (u.includes('MYANMAR')) return 'MM';
        if (u.includes('PHILIPPINES')) return 'PH';
        if (u.includes('EGYPT')) return 'EG';
        if (u.includes('MOROCCO')) return 'MA';
        if (u.includes('SOUTH AFRICA')) return 'ZA';
        if (u.includes('KENYA')) return 'KE';
        if (u.includes('UAE') || u.includes('DUBAI') || u.includes('UNITED ARAB EMIRATES')) return 'AE';
    }

    // Heuristic postcode patterns
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

// ─── Main resolver ──────────────────────────────

/**
 * Resolve coordinates from an address, using a layered strategy:
 *
 *   1. existing  — coordinates already provided (no work needed)
 *   2. city      — direct or partial match in CityCoordinates
 *   3. postcode  — prefix match in PostcodePrefixes
 *   4. address_keyword — extract city keyword from free-text address
 *
 * 全部层未命中时返回 null（诚实缺省）：哈希伪随机坐标兜底已退役，
 * 调用方需容忍 null（不保存坐标/不上图）。
 */
export function resolveCoordinates(
    existing: { lat: number; lng: number } | undefined,
    address: AddressInput
): ResolvedCoordinates | null {
    // Layer 0: existing coordinates
    if (existing && isFinite(existing.lat) && isFinite(existing.lng)) {
        return { lat: existing.lat, lng: existing.lng, source: 'existing' };
    }

    // Layer 1: city name match
    const cityName = address.city?.trim();
    if (cityName) {
        if (CityCoordinates[cityName]) {
            const c = CityCoordinates[cityName];
            return { lat: c.lat, lng: c.lon, source: 'city', label: cityName };
        }
        const keys = Object.keys(CityCoordinates);
        const partial = keys.find(key => cityName.includes(key));
        if (partial) {
            const c = CityCoordinates[partial];
            return { lat: c.lat, lng: c.lon, source: 'city', label: partial };
        }
    }

    // Layer 2: postcode match
    const postcode = address.postcode?.trim();
    const country = address.country?.trim() || inferCountry(address.address, postcode);
    if (postcode && country) {
        const pc = resolvePostcode(postcode, country);
        if (pc) {
            return { lat: pc.lat, lng: pc.lon, source: 'postcode', label: pc.label };
        }
    }

    // Layer 3: address keyword extraction
    const addressTexts = [
        address.address,
        address.city,
    ].filter(Boolean).join(' ');

    if (addressTexts) {
        const extracted = extractCityFromText(addressTexts);
        if (extracted) {
            const c = CityCoordinates[extracted.key];
            return { lat: c.lat, lng: c.lon, source: 'address_keyword', label: extracted.key };
        }
    }

    // 全部层未命中：返回 null（原哈希伪随机兜底已退役，禁止伪造坐标）
    return null;
}

// ─── Batch utility ──────────────────────────────

/**
 * Extract structured address from a Relation object for resolution.
 */
export function extractAddressFromRelation(relation: {
    officialAddress?: string;
    factoryAddresses?: string[];
    shipToAddresses?: Array<{ city?: string; address?: string }>;
    shippingAddress?: string;
    country?: string;
}): AddressInput {
    let city: string | undefined;
    let address: string | undefined;
    let country: string | undefined;

    // Try shipToAddresses first (most structured)
    if (relation.shipToAddresses && relation.shipToAddresses.length > 0) {
        const primary = relation.shipToAddresses[0];
        city = primary.city?.trim();
        address = primary.address?.trim();
    }

    // Fallback to officialAddress
    if (!city && relation.officialAddress) {
        address = relation.officialAddress.trim();
    }

    // Fallback to first factory address
    if (!city && relation.factoryAddresses && relation.factoryAddresses.length > 0) {
        address = (relation.factoryAddresses[0] || '').trim();
    }

    // Shipping address as last resort
    if (!city && !address && relation.shippingAddress) {
        address = relation.shippingAddress.trim();
    }

    country = relation.country?.trim();

    return { city, address, country };
}
