/**
 * Postcode prefix → coordinate mapping for major countries.
 *
 * Resolution strategy: match the postcode against the longest matching prefix
 * for the given country code. This gives city-level accuracy without any
 * external API call.
 *
 * Data sources: national postal service documentation, GeoNames.
 */

export interface PostcodeEntry {
    /** Prefix to match against the start of the postcode string. */
    prefix: string;
    lat: number;
    lon: number;
    /** Optional label for debugging / display. */
    label?: string;
}

/**
 * Country-code → sorted array of postcode entries (longest prefix first).
 * When resolving, we iterate and take the first match.
 */
export const PostcodePrefixes: Record<string, PostcodeEntry[]> = {
    // ═══════════════════════════════════════════
    // China (6-digit postal codes)
    // ═══════════════════════════════════════════
    CN: [
        // Shanghai 20xxxx
        { prefix: '200', lat: 31.23, lon: 121.47, label: 'Shanghai' },
        // Guangzhou 51xxxx
        { prefix: '510', lat: 23.13, lon: 113.26, label: 'Guangzhou' },
        { prefix: '511', lat: 23.13, lon: 113.26, label: 'Guangzhou' },
        // Shenzhen 518xxxx
        { prefix: '518', lat: 22.55, lon: 114.06, label: 'Shenzhen' },
        // Hangzhou 31xxxx
        { prefix: '310', lat: 30.27, lon: 120.16, label: 'Hangzhou' },
        { prefix: '311', lat: 30.27, lon: 120.16, label: 'Hangzhou' },
        // Ningbo 315xxxx
        { prefix: '315', lat: 29.87, lon: 121.54, label: 'Ningbo' },
        // Suzhou 215xxxx
        { prefix: '215', lat: 31.30, lon: 120.59, label: 'Suzhou' },
        // Wuxi 214xxxx
        { prefix: '214', lat: 31.49, lon: 120.31, label: 'Wuxi' },
        // Changzhou 213xxxx
        { prefix: '213', lat: 31.81, lon: 119.97, label: 'Changzhou' },
        // Nantong 226xxxx
        { prefix: '226', lat: 32.06, lon: 120.89, label: 'Nantong' },
        // Shaoxing 312xxxx
        { prefix: '312', lat: 30.08, lon: 120.49, label: 'Shaoxing' },
        // Jinhua 321xxxx
        { prefix: '321', lat: 29.08, lon: 119.65, label: 'Jinhua' },
        // Beijing 10xxxx
        { prefix: '100', lat: 39.90, lon: 116.41, label: 'Beijing' },
        { prefix: '101', lat: 39.90, lon: 116.41, label: 'Beijing' },
        // Tianjin 30xxxx
        { prefix: '300', lat: 39.34, lon: 117.36, label: 'Tianjin' },
        // Qingdao 266xxxx
        { prefix: '266', lat: 36.07, lon: 120.38, label: 'Qingdao' },
        // Dalian 116xxxx
        { prefix: '116', lat: 38.91, lon: 121.61, label: 'Dalian' },
        // Xiamen 361xxxx
        { prefix: '361', lat: 24.48, lon: 118.09, label: 'Xiamen' },
        // Fuzhou 350xxxx
        { prefix: '350', lat: 26.07, lon: 119.30, label: 'Fuzhou' },
        // Wuhan 430xxxx
        { prefix: '430', lat: 30.59, lon: 114.31, label: 'Wuhan' },
        // Chengdu 610xxxx
        { prefix: '610', lat: 30.57, lon: 104.07, label: 'Chengdu' },
        // Chongqing 400xxxx
        { prefix: '400', lat: 29.43, lon: 106.91, label: 'Chongqing' },
        // Dongguan 523xxxx
        { prefix: '523', lat: 23.02, lon: 113.75, label: 'Dongguan' },
        // Foshan 528xxxx
        { prefix: '528', lat: 23.02, lon: 113.12, label: 'Foshan' },
    ],

    // ═══════════════════════════════════════════
    // Bangladesh (4-digit postal codes)
    // ═══════════════════════════════════════════
    BD: [
        { prefix: '1000', lat: 23.81, lon: 90.41, label: 'Dhaka' },
        { prefix: '1200', lat: 23.81, lon: 90.41, label: 'Dhaka' },
        { prefix: '1300', lat: 23.81, lon: 90.41, label: 'Dhaka' },
        { prefix: '4000', lat: 22.36, lon: 91.78, label: 'Chittagong' },
        { prefix: '3000', lat: 24.37, lon: 88.60, label: 'Rajshahi' },
        { prefix: '2200', lat: 24.90, lon: 91.87, label: 'Sylhet' },
    ],

    // ═══════════════════════════════════════════
    // Vietnam (6-digit postal codes)
    // ═══════════════════════════════════════════
    VN: [
        { prefix: '700', lat: 10.82, lon: 106.63, label: 'Ho Chi Minh City' },
        { prefix: '710', lat: 10.82, lon: 106.63, label: 'Ho Chi Minh City' },
        { prefix: '720', lat: 10.82, lon: 106.63, label: 'HCMC area' },
        { prefix: '100', lat: 21.03, lon: 105.85, label: 'Hanoi' },
        { prefix: '110', lat: 21.03, lon: 105.85, label: 'Hanoi' },
        { prefix: '550', lat: 16.05, lon: 108.20, label: 'Da Nang' },
    ],

    // ═══════════════════════════════════════════
    // Thailand (5-digit postal codes)
    // ═══════════════════════════════════════════
    TH: [
        { prefix: '101', lat: 13.76, lon: 100.50, label: 'Bangkok' },
        { prefix: '102', lat: 13.76, lon: 100.50, label: 'Bangkok' },
        { prefix: '103', lat: 13.76, lon: 100.50, label: 'Bangkok' },
        { prefix: '104', lat: 13.76, lon: 100.50, label: 'Bangkok' },
        { prefix: '105', lat: 13.76, lon: 100.50, label: 'Bangkok' },
        { prefix: '200', lat: 18.79, lon: 98.98, label: 'Chiang Mai' },
        { prefix: '300', lat: 14.03, lon: 100.52, label: 'Nakhon Ratchasima' },
    ],

    // ═══════════════════════════════════════════
    // Indonesia (5-digit postal codes)
    // ═══════════════════════════════════════════
    ID: [
        { prefix: '101', lat: -6.21, lon: 106.85, label: 'Jakarta' },
        { prefix: '102', lat: -6.21, lon: 106.85, label: 'Jakarta' },
        { prefix: '103', lat: -6.21, lon: 106.85, label: 'Jakarta' },
        { prefix: '104', lat: -6.21, lon: 106.85, label: 'Jakarta' },
        { prefix: '401', lat: -6.92, lon: 107.62, label: 'Bandung' },
        { prefix: '501', lat: -7.26, lon: 112.75, label: 'Surabaya' },
        { prefix: '601', lat: -7.80, lon: 110.36, label: 'Solo' },
        { prefix: '801', lat: -8.65, lon: 115.22, label: 'Bali' },
    ],

    // ═══════════════════════════════════════════
    // India (6-digit PIN codes)
    // ═══════════════════════════════════════════
    IN: [
        { prefix: '400', lat: 19.08, lon: 72.88, label: 'Mumbai' },
        { prefix: '110', lat: 28.61, lon: 77.21, label: 'New Delhi' },
        { prefix: '560', lat: 12.97, lon: 77.59, label: 'Bangalore' },
        { prefix: '600', lat: 13.08, lon: 80.27, label: 'Chennai' },
        { prefix: '700', lat: 22.57, lon: 88.36, label: 'Kolkata' },
        { prefix: '380', lat: 23.02, lon: 72.57, label: 'Ahmedabad' },
        { prefix: '500', lat: 17.39, lon: 78.49, label: 'Hyderabad' },
        { prefix: '411', lat: 18.52, lon: 73.86, label: 'Pune' },
        { prefix: '302', lat: 26.91, lon: 75.79, label: 'Jaipur' },
        { prefix: '122', lat: 28.46, lon: 77.04, label: 'Gurgaon' },
        { prefix: '201', lat: 28.63, lon: 77.22, label: 'Noida' },
        { prefix: '641', lat: 11.02, lon: 76.96, label: 'Coimbatore' },
        { prefix: '530', lat: 17.69, lon: 83.20, label: 'Visakhapatnam' },
    ],

    // ═══════════════════════════════════════════
    // Pakistan (5-digit postal codes)
    // ═══════════════════════════════════════════
    PK: [
        { prefix: '540', lat: 31.52, lon: 74.36, label: 'Lahore' },
        { prefix: '740', lat: 24.86, lon: 67.00, label: 'Karachi' },
        { prefix: '440', lat: 33.69, lon: 73.04, label: 'Islamabad' },
        { prefix: '460', lat: 33.69, lon: 73.04, label: 'Rawalpindi' },
        { prefix: '250', lat: 34.01, lon: 71.58, label: 'Peshawar' },
    ],

    // ═══════════════════════════════════════════
    // Turkey (5-digit postal codes)
    // ═══════════════════════════════════════════
    TR: [
        { prefix: '340', lat: 41.01, lon: 28.98, label: 'Istanbul' },
        { prefix: '341', lat: 41.01, lon: 28.98, label: 'Istanbul' },
        { prefix: '342', lat: 41.01, lon: 28.98, label: 'Istanbul' },
        { prefix: '343', lat: 41.01, lon: 28.98, label: 'Istanbul' },
        { prefix: '350', lat: 38.42, lon: 27.13, label: 'Izmir' },
        { prefix: '060', lat: 39.93, lon: 32.86, label: 'Ankara' },
    ],

    // ═══════════════════════════════════════════
    // UK (outward code area — first 2-4 chars)
    // ═══════════════════════════════════════════
    GB: [
        { prefix: 'E', lat: 51.53, lon: -0.04, label: 'London East' },
        { prefix: 'W', lat: 51.51, lon: -0.14, label: 'London West' },
        { prefix: 'SW', lat: 51.47, lon: -0.17, label: 'London SW' },
        { prefix: 'SE', lat: 51.48, lon: -0.08, label: 'London SE' },
        { prefix: 'NW', lat: 51.55, lon: -0.16, label: 'London NW' },
        { prefix: 'N', lat: 51.55, lon: -0.12, label: 'London North' },
        { prefix: 'EC', lat: 51.52, lon: -0.08, label: 'London EC' },
        { prefix: 'WC', lat: 51.52, lon: -0.12, label: 'London WC' },
        { prefix: 'M', lat: 53.48, lon: -2.24, label: 'Manchester' },
        { prefix: 'B', lat: 52.48, lon: -1.90, label: 'Birmingham' },
        { prefix: 'LS', lat: 53.80, lon: -1.55, label: 'Leeds' },
        { prefix: 'G', lat: 55.86, lon: -4.25, label: 'Glasgow' },
        { prefix: 'EH', lat: 55.95, lon: -3.19, label: 'Edinburgh' },
        { prefix: 'CF', lat: 51.48, lon: -3.18, label: 'Cardiff' },
        { prefix: 'BT', lat: 54.60, lon: -5.93, label: 'Belfast' },
        { prefix: 'CB', lat: 52.20, lon: 0.13, label: 'Cambridge' },
        { prefix: 'OX', lat: 51.75, lon: -1.26, label: 'Oxford' },
    ],

    // ═══════════════════════════════════════════
    // Germany (5-digit PLZ)
    // ═══════════════════════════════════════════
    DE: [
        { prefix: '101', lat: 52.52, lon: 13.41, label: 'Berlin' },
        { prefix: '803', lat: 48.14, lon: 11.58, label: 'Munich' },
        { prefix: '200', lat: 53.55, lon: 10.00, label: 'Hamburg' },
        { prefix: '603', lat: 50.11, lon: 8.68, label: 'Frankfurt' },
        { prefix: '402', lat: 51.22, lon: 6.77, label: 'Dusseldorf' },
        { prefix: '451', lat: 51.46, lon: 7.01, label: 'Essen' },
        { prefix: '506', lat: 50.94, lon: 6.96, label: 'Cologne' },
        { prefix: '701', lat: 48.78, lon: 9.18, label: 'Stuttgart' },
        { prefix: '301', lat: 52.37, lon: 9.73, label: 'Hanover' },
        { prefix: '041', lat: 51.34, lon: 12.37, label: 'Leipzig' },
    ],

    // ═══════════════════════════════════════════
    // Italy (5-digit CAP)
    // ═══════════════════════════════════════════
    IT: [
        { prefix: '201', lat: 45.46, lon: 9.19, label: 'Milan' },
        { prefix: '001', lat: 41.90, lon: 12.50, label: 'Rome' },
        { prefix: '501', lat: 43.77, lon: 11.26, label: 'Florence' },
        { prefix: '801', lat: 40.85, lon: 14.27, label: 'Naples' },
        { prefix: '101', lat: 45.07, lon: 7.69, label: 'Turin' },
        { prefix: '401', lat: 44.49, lon: 11.34, label: 'Bologna' },
        { prefix: '351', lat: 45.41, lon: 11.87, label: 'Padova' },
        { prefix: '371', lat: 45.44, lon: 10.99, label: 'Verona' },
        { prefix: '251', lat: 45.47, lon: 9.19, label: 'Brescia' },
        { prefix: '591', lat: 43.77, lon: 11.25, label: 'Prato' },
    ],

    // ═══════════════════════════════════════════
    // France (5-digit)
    // ═══════════════════════════════════════════
    FR: [
        { prefix: '750', lat: 48.86, lon: 2.35, label: 'Paris' },
        { prefix: '690', lat: 45.76, lon: 4.84, label: 'Lyon' },
        { prefix: '130', lat: 43.30, lon: 5.37, label: 'Marseille' },
        { prefix: '310', lat: 43.60, lon: 1.44, label: 'Toulouse' },
        { prefix: '330', lat: 44.84, lon: -0.58, label: 'Bordeaux' },
        { prefix: '590', lat: 50.63, lon: 3.07, label: 'Lille' },
        { prefix: '670', lat: 48.58, lon: 7.75, label: 'Strasbourg' },
    ],

    // ═══════════════════════════════════════════
    // Spain (5-digit)
    // ═══════════════════════════════════════════
    ES: [
        { prefix: '080', lat: 41.39, lon: 2.17, label: 'Barcelona' },
        { prefix: '280', lat: 40.42, lon: -3.70, label: 'Madrid' },
        { prefix: '460', lat: 39.47, lon: -0.38, label: 'Valencia' },
        { prefix: '410', lat: 37.39, lon: -5.99, label: 'Seville' },
        { prefix: '290', lat: 36.72, lon: -4.42, label: 'Malaga' },
        { prefix: '480', lat: 43.26, lon: -2.93, label: 'Bilbao' },
    ],

    // ═══════════════════════════════════════════
    // Portugal (4-digit + 3-digit hyphenated, use first 4)
    // ═══════════════════════════════════════════
    PT: [
        { prefix: '1000', lat: 38.72, lon: -9.14, label: 'Lisbon' },
        { prefix: '4000', lat: 41.16, lon: -8.63, label: 'Porto' },
        { prefix: '3000', lat: 40.20, lon: -8.42, label: 'Coimbra' },
        { prefix: '8000', lat: 37.03, lon: -7.93, label: 'Faro' },
    ],

    // ═══════════════════════════════════════════
    // USA (5-digit ZIP)
    // ═══════════════════════════════════════════
    US: [
        { prefix: '100', lat: 40.71, lon: -74.01, label: 'New York' },
        { prefix: '900', lat: 34.05, lon: -118.24, label: 'Los Angeles' },
        { prefix: '600', lat: 41.88, lon: -87.63, label: 'Chicago' },
        { prefix: '770', lat: 29.76, lon: -95.37, label: 'Houston' },
        { prefix: '330', lat: 25.76, lon: -80.19, label: 'Miami' },
        { prefix: '940', lat: 37.77, lon: -122.42, label: 'San Francisco' },
        { prefix: '750', lat: 32.78, lon: -96.80, label: 'Dallas' },
        { prefix: '303', lat: 33.75, lon: -84.39, label: 'Atlanta' },
        { prefix: '021', lat: 42.36, lon: -71.06, label: 'Boston' },
        { prefix: '200', lat: 38.91, lon: -77.04, label: 'Washington DC' },
        { prefix: '981', lat: 47.61, lon: -122.33, label: 'Seattle' },
        { prefix: '554', lat: 44.98, lon: -93.27, label: 'Minneapolis' },
        { prefix: '191', lat: 39.95, lon: -75.17, label: 'Philadelphia' },
        { prefix: '850', lat: 33.45, lon: -112.07, label: 'Phoenix' },
        { prefix: '787', lat: 30.27, lon: -97.74, label: 'Austin' },
        { prefix: '802', lat: 39.74, lon: -104.99, label: 'Denver' },
    ],

    // ═══════════════════════════════════════════
    // Canada (alphanumeric, first 3 chars)
    // ═══════════════════════════════════════════
    CA: [
        { prefix: 'M', lat: 43.65, lon: -79.38, label: 'Toronto' },
        { prefix: 'V', lat: 49.28, lon: -123.12, label: 'Vancouver' },
        { prefix: 'H', lat: 45.50, lon: -73.57, label: 'Montreal' },
        { prefix: 'T', lat: 51.05, lon: -114.07, label: 'Calgary' },
        { prefix: 'K', lat: 45.42, lon: -75.70, label: 'Ottawa' },
        { prefix: 'R', lat: 49.90, lon: -97.14, label: 'Winnipeg' },
    ],

    // ═══════════════════════════════════════════
    // Mexico (5-digit C.P.)
    // ═══════════════════════════════════════════
    MX: [
        { prefix: '060', lat: 19.43, lon: -99.13, label: 'Mexico City' },
        { prefix: '066', lat: 19.43, lon: -99.13, label: 'Mexico City' },
        { prefix: '440', lat: 20.67, lon: -103.35, label: 'Guadalajara' },
        { prefix: '640', lat: 25.67, lon: -100.31, label: 'Monterrey' },
        { prefix: '770', lat: 21.16, lon: -86.85, label: 'Cancun' },
        { prefix: '830', lat: 27.48, lon: -109.97, label: 'Hermosillo' },
    ],

    // ═══════════════════════════════════════════
    // Brazil (8-digit CEP, use first 5)
    // ═══════════════════════════════════════════
    BR: [
        { prefix: '010', lat: -23.55, lon: -46.63, label: 'Sao Paulo' },
        { prefix: '200', lat: -22.91, lon: -43.17, label: 'Rio de Janeiro' },
        { prefix: '300', lat: -19.92, lon: -43.94, label: 'Belo Horizonte' },
        { prefix: '400', lat: -12.97, lon: -38.51, label: 'Salvador' },
        { prefix: '600', lat: -3.72, lon: -38.53, label: 'Fortaleza' },
        { prefix: '700', lat: -30.03, lon: -51.23, label: 'Porto Alegre' },
        { prefix: '800', lat: -25.43, lon: -49.27, label: 'Curitiba' },
        { prefix: '900', lat: -8.05, lon: -34.87, label: 'Recife' },
    ],

    // ═══════════════════════════════════════════
    // Cambodia (5-6 digit, use first 3)
    // ═══════════════════════════════════════════
    KH: [
        { prefix: '120', lat: 11.56, lon: 104.93, label: 'Phnom Penh' },
        { prefix: '210', lat: 12.56, lon: 104.91, label: 'Kampong Cham' },
        { prefix: '020', lat: 11.56, lon: 104.93, label: 'Phnom Penh' },
    ],

    // ═══════════════════════════════════════════
    // Myanmar (5-digit)
    // ═══════════════════════════════════════════
    MM: [
        { prefix: '111', lat: 16.87, lon: 96.20, label: 'Yangon' },
        { prefix: '050', lat: 21.97, lon: 96.08, label: 'Mandalay' },
    ],

    // ═══════════════════════════════════════════
    // Philippines (4-digit)
    // ═══════════════════════════════════════════
    PH: [
        { prefix: '100', lat: 14.60, lon: 120.98, label: 'Manila' },
        { prefix: '600', lat: 10.32, lon: 123.89, label: 'Cebu' },
        { prefix: '800', lat: 7.07, lon: 125.61, label: 'Davao' },
        { prefix: '200', lat: 14.60, lon: 121.04, label: 'Quezon City' },
    ],

    // ═══════════════════════════════════════════
    // South Korea (5-digit)
    // ═══════════════════════════════════════════
    KR: [
        { prefix: '030', lat: 37.57, lon: 126.98, label: 'Seoul' },
        { prefix: '040', lat: 37.57, lon: 126.98, label: 'Seoul' },
        { prefix: '470', lat: 35.18, lon: 129.08, label: 'Busan' },
        { prefix: '410', lat: 35.87, lon: 128.60, label: 'Daegu' },
        { prefix: '210', lat: 37.45, lon: 126.69, label: 'Incheon' },
    ],

    // ═══════════════════════════════════════════
    // Japan (3-digit + 4, use first 3)
    // ═══════════════════════════════════════════
    JP: [
        { prefix: '100', lat: 35.68, lon: 139.65, label: 'Tokyo' },
        { prefix: '150', lat: 35.68, lon: 139.65, label: 'Tokyo' },
        { prefix: '530', lat: 34.69, lon: 135.50, label: 'Osaka' },
        { prefix: '460', lat: 35.18, lon: 136.91, label: 'Nagoya' },
        { prefix: '810', lat: 33.59, lon: 130.40, label: 'Fukuoka' },
    ],

    // ═══════════════════════════════════════════
    // Egypt (5-digit)
    // ═══════════════════════════════════════════
    EG: [
        { prefix: '115', lat: 30.04, lon: 31.24, label: 'Cairo' },
        { prefix: '215', lat: 31.20, lon: 29.92, label: 'Alexandria' },
        { prefix: '335', lat: 30.01, lon: 31.27, label: 'Giza' },
    ],

    // ═══════════════════════════════════════════
    // Morocco (5-digit)
    // ═══════════════════════════════════════════
    MA: [
        { prefix: '200', lat: 33.57, lon: -7.59, label: 'Casablanca' },
        { prefix: '100', lat: 33.97, lon: -6.85, label: 'Rabat' },
        { prefix: '900', lat: 35.76, lon: -5.83, label: 'Tangier' },
        { prefix: '400', lat: 34.03, lon: -5.00, label: 'Fez' },
        { prefix: '300', lat: 31.63, lon: -7.98, label: 'Marrakech' },
    ],

    // ═══════════════════════════════════════════
    // South Africa (4-digit)
    // ═══════════════════════════════════════════
    ZA: [
        { prefix: '200', lat: -26.20, lon: 28.05, label: 'Johannesburg' },
        { prefix: '800', lat: -33.92, lon: 18.42, label: 'Cape Town' },
        { prefix: '400', lat: -29.86, lon: 31.02, label: 'Durban' },
        { prefix: '000', lat: -25.75, lon: 28.19, label: 'Pretoria' },
    ],

    // ═══════════════════════════════════════════
    // Kenya (5-digit)
    // ═══════════════════════════════════════════
    KE: [
        { prefix: '001', lat: -1.29, lon: 36.82, label: 'Nairobi' },
        { prefix: '801', lat: -4.05, lon: 39.67, label: 'Mombasa' },
    ],

    // ═══════════════════════════════════════════
    // UAE (no formal postcode; use area codes)
    // ═══════════════════════════════════════════
    AE: [
        { prefix: '000', lat: 25.20, lon: 55.27, label: 'Dubai' },
    ],
};

/**
 * Resolve coordinates from a postcode and country code.
 * Returns the longest-prefix match, or null if no match found.
 */
export function resolvePostcode(postcode: string, countryCode: string): { lat: number; lon: number; label?: string } | null {
    const entries = PostcodePrefixes[countryCode.toUpperCase()];
    if (!entries || !postcode) return null;

    const pc = postcode.trim();

    // Sort by prefix length descending (longest match first)
    const sorted = [...entries].sort((a, b) => b.prefix.length - a.prefix.length);

    for (const entry of sorted) {
        if (pc.startsWith(entry.prefix)) {
            return { lat: entry.lat, lon: entry.lon, label: entry.label };
        }
    }

    return null;
}
