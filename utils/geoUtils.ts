
export const CityCoordinates: Record<string, { lat: number; lon: number }> = {
    // ═══════════════════════════════════════════
    // China — East (长三角 / Jiangsu-Zhejiang-Shanghai)
    // ═══════════════════════════════════════════
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
    'Yangzhou': { lat: 32.3936, lon: 119.4129 },
    'Zhenjiang': { lat: 32.1875, lon: 119.4251 },
    'Huzhou': { lat: 30.8724, lon: 120.0886 },
    'Yiwu': { lat: 29.3051, lon: 120.0750 },

    // ═══════════════════════════════════════════
    // China — South (珠三角 / Pearl River Delta)
    // ═══════════════════════════════════════════
    'Shenzhen': { lat: 22.5431, lon: 114.0579 },
    'Guangzhou': { lat: 23.1291, lon: 113.2644 },
    'Dongguan': { lat: 23.0208, lon: 113.7518 },
    'Foshan': { lat: 23.0218, lon: 113.1219 },
    'Zhongshan': { lat: 22.5171, lon: 113.3926 },
    'Zhuhai': { lat: 22.2710, lon: 113.5767 },
    'Huizhou': { lat: 23.1116, lon: 114.4159 },
    'Jiangmen': { lat: 22.5789, lon: 113.0815 },
    'Shantou': { lat: 23.3535, lon: 116.6820 },

    // ═══════════════════════════════════════════
    // China — North / Northeast
    // ═══════════════════════════════════════════
    'Beijing': { lat: 39.9042, lon: 116.4074 },
    'Tianjin': { lat: 39.3434, lon: 117.3616 },
    'Qingdao': { lat: 36.0671, lon: 120.3826 },
    'Dalian': { lat: 38.9140, lon: 121.6147 },
    'Jinan': { lat: 36.6512, lon: 116.9972 },
    'Shenyang': { lat: 41.8057, lon: 123.4315 },
    'Weifang': { lat: 36.7069, lon: 119.1619 },
    'Yantai': { lat: 37.4638, lon: 121.4479 },

    // ═══════════════════════════════════════════
    // China — Central / Southwest
    // ═══════════════════════════════════════════
    'Wuhan': { lat: 30.5928, lon: 114.3055 },
    'Chengdu': { lat: 30.5728, lon: 104.0668 },
    'Chongqing': { lat: 29.4316, lon: 106.9123 },
    'Xiamen': { lat: 24.4798, lon: 118.0894 },
    'Fuzhou': { lat: 26.0745, lon: 119.2965 },
    'Quanzhou': { lat: 24.8741, lon: 118.6757 },
    'Changsha': { lat: 28.2282, lon: 112.9388 },
    'Zhengzhou': { lat: 34.7466, lon: 113.6254 },
    'Kunming': { lat: 25.0389, lon: 102.7183 },
    'Guiyang': { lat: 26.6470, lon: 106.6302 },
    'Nanning': { lat: 22.8170, lon: 108.3665 },

    // ═══════════════════════════════════════════
    // East Asia
    // ═══════════════════════════════════════════
    'Tokyo': { lat: 35.6762, lon: 139.6503 },
    'Osaka': { lat: 34.6937, lon: 135.5023 },
    'Seoul': { lat: 37.5665, lon: 126.9780 },
    'Busan': { lat: 35.1796, lon: 129.0756 },
    'Daegu': { lat: 35.8714, lon: 128.6014 },

    // ═══════════════════════════════════════════
    // Southeast Asia
    // ═══════════════════════════════════════════
    'Ho Chi Minh City': { lat: 10.8231, lon: 106.6297 },
    'Hanoi': { lat: 21.0285, lon: 105.8542 },
    'Bangkok': { lat: 13.7563, lon: 100.5018 },
    'Jakarta': { lat: -6.2088, lon: 106.8456 },
    'Phnom Penh': { lat: 11.5564, lon: 104.9282 },
    'Yangon': { lat: 16.8661, lon: 96.1951 },
    'Manila': { lat: 14.5995, lon: 120.9842 },
    'Kuala Lumpur': { lat: 3.1390, lon: 101.6869 },
    'Singapore': { lat: 1.3521, lon: 103.8198 },
    'Surabaya': { lat: -7.2575, lon: 112.7521 },
    'Bandung': { lat: -6.9175, lon: 107.6191 },
    'Chittagong': { lat: 22.3569, lon: 91.7832 },

    // ═══════════════════════════════════════════
    // South Asia
    // ═══════════════════════════════════════════
    'Dhaka': { lat: 23.8103, lon: 90.4125 },
    'Mumbai': { lat: 19.0760, lon: 72.8777 },
    'New Delhi': { lat: 28.6139, lon: 77.2090 },
    'Chennai': { lat: 13.0827, lon: 80.2707 },
    'Karachi': { lat: 24.8607, lon: 67.0011 },
    'Lahore': { lat: 31.5204, lon: 74.3587 },
    'Colombo': { lat: 6.9271, lon: 79.8612 },

    // ═══════════════════════════════════════════
    // Europe — West
    // ═══════════════════════════════════════════
    'London': { lat: 51.5074, lon: -0.1278 },
    'Paris': { lat: 48.8566, lon: 2.3522 },
    'Amsterdam': { lat: 52.3676, lon: 4.9041 },
    'Rotterdam': { lat: 51.9244, lon: 4.4777 },
    'Brussels': { lat: 50.8503, lon: 4.3517 },
    'Dublin': { lat: 53.3498, lon: -6.2603 },
    'Lisbon': { lat: 38.7223, lon: -9.1393 },
    'Porto': { lat: 41.1579, lon: -8.6291 },
    'Madrid': { lat: 40.4168, lon: -3.7038 },
    'Barcelona': { lat: 41.3874, lon: 2.1686 },

    // ═══════════════════════════════════════════
    // Europe — Central / East
    // ═══════════════════════════════════════════
    'Milan': { lat: 45.4642, lon: 9.1900 },
    'Florence': { lat: 43.7696, lon: 11.2558 },
    'Munich': { lat: 48.1351, lon: 11.5820 },
    'Frankfurt': { lat: 50.1109, lon: 8.6821 },
    'Essen': { lat: 51.4556, lon: 7.0116 },
    'Hamburg': { lat: 53.5511, lon: 9.9937 },
    'Berlin': { lat: 52.5200, lon: 13.4050 },
    'Zurich': { lat: 47.3769, lon: 8.5417 },
    'Vienna': { lat: 48.2082, lon: 16.3738 },
    'Prague': { lat: 50.0755, lon: 14.4378 },
    'Warsaw': { lat: 52.2297, lon: 21.0122 },
    'Budapest': { lat: 47.4979, lon: 19.0402 },
    'Bucharest': { lat: 44.4268, lon: 26.1025 },
    'Istanbul': { lat: 41.0082, lon: 28.9784 },
    'Athens': { lat: 37.9838, lon: 23.7275 },

    // ═══════════════════════════════════════════
    // Europe — Nordic
    // ═══════════════════════════════════════════
    'Stockholm': { lat: 59.3293, lon: 18.0686 },
    'Copenhagen': { lat: 55.6761, lon: 12.5683 },
    'Helsinki': { lat: 60.1699, lon: 24.9384 },
    'Oslo': { lat: 59.9139, lon: 10.7522 },

    // ═══════════════════════════════════════════
    // Americas — North
    // ═══════════════════════════════════════════
    'New York': { lat: 40.7128, lon: -74.0060 },
    'Los Angeles': { lat: 34.0522, lon: -118.2437 },
    'Chicago': { lat: 41.8781, lon: -87.6298 },
    'Miami': { lat: 25.7617, lon: -80.1918 },
    'San Francisco': { lat: 37.7749, lon: -122.4194 },
    'Dallas': { lat: 32.7767, lon: -96.7970 },
    'Atlanta': { lat: 33.7490, lon: -84.3880 },
    'Toronto': { lat: 43.6532, lon: -79.3832 },
    'Vancouver': { lat: 49.2827, lon: -123.1207 },
    'Montreal': { lat: 45.5017, lon: -73.5673 },
    'Mexico City': { lat: 19.4326, lon: -99.1332 },
    'Guatemala City': { lat: 14.6349, lon: -90.5069 },
    'San Pedro Sula': { lat: 15.5053, lon: -88.0249 },

    // ═══════════════════════════════════════════
    // Americas — South
    // ═══════════════════════════════════════════
    'Sao Paulo': { lat: -23.5505, lon: -46.6333 },
    'Rio de Janeiro': { lat: -22.9068, lon: -43.1729 },
    'Buenos Aires': { lat: -34.6037, lon: -58.3816 },
    'Lima': { lat: -12.0464, lon: -77.0428 },
    'Bogota': { lat: 4.7110, lon: -74.0721 },
    'Santiago': { lat: -33.4489, lon: -70.6693 },
    'Medellin': { lat: 6.2442, lon: -75.5812 },

    // ═══════════════════════════════════════════
    // Africa
    // ═══════════════════════════════════════════
    'Cairo': { lat: 30.0444, lon: 31.2357 },
    'Alexandria': { lat: 31.2001, lon: 29.9187 },
    'Addis Ababa': { lat: 9.0331, lon: 38.7444 },
    'Nairobi': { lat: -1.2921, lon: 36.8219 },
    'Lagos': { lat: 6.5244, lon: 3.3792 },
    'Casablanca': { lat: 33.5731, lon: -7.5898 },
    'Tangier': { lat: 35.7595, lon: -5.8340 },
    'Johannesburg': { lat: -26.2041, lon: 28.0473 },
    'Cape Town': { lat: -33.9249, lon: 18.4241 },
    'Durban': { lat: -29.8587, lon: 31.0218 },
    'Dar es Salaam': { lat: -6.7924, lon: 39.2083 },
    'Accra': { lat: 5.6037, lon: -0.1870 },
    'Tunis': { lat: 36.8065, lon: 10.1815 },

    // ═══════════════════════════════════════════
    // Middle East / Central Asia
    // ═══════════════════════════════════════════
    'Dubai': { lat: 25.2048, lon: 55.2708 },
    'Tashkent': { lat: 41.2995, lon: 69.2401 },
    'Baku': { lat: 40.4093, lon: 49.8671 },
};

/**
 * 厂名/地名 → 坐标解析。仅命中 CityCoordinates 真实地名表（直接/部分匹配）才返回坐标；
 * 无法匹配时返回 null（不上图），由调用方跳过渲染。
 *
 * 注：原"哈希伪随机坐标兜底"已退役（假数据清零）——伪造坐标会把订单光束/巡航点位
 * 渲染到随机位置，误导生产判读。坐标真源（Relation 挂 lat/lon 入库）待 v1.1 立项，
 * 登记于 docs/design/09-路线图与技术债务/技术债务登记.md。
 */
export const resolveLocation = (location: string): { lat: number; lon: number } | null => {
    // 1. Direct Match
    if (CityCoordinates[location]) {
        return CityCoordinates[location];
    }

    // 2. Partial Match
    const keys = Object.keys(CityCoordinates);
    const match = keys.find(key => location.includes(key));
    if (match) {
        return CityCoordinates[match];
    }

    // 3. 无匹配 → null（诚实缺省，禁止伪造坐标）
    return null;
};
