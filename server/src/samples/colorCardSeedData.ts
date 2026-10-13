/**
 * colorCardSeedData.ts — REQ2-09 Pantone TCX 常用色种子子集（DR-051-①）
 *
 * 数据口径：公开近似 sRGB 值（行业通行 TPX/TCX 对照表口径），非 Pantone 官方授权精确值。
 * 界面与文档显式标注"对色以实物色卡为准"。
 * 收录原则：面料/成衣高频色 + Pantone 年度色 + 经典基础色，覆盖 12 个色系。
 */

export interface PantoneSeedColor {
  code: string;
  name: string;
  family: string;
  r: number;
  g: number;
  b: number;
}

export const PANTONE_TCX_SEED: PantoneSeedColor[] = [
  // ─── White / 白（面料底色） ───
  { code: '11-0601 TCX', name: 'Bright White', family: 'White', r: 243, g: 244, b: 243 },
  { code: '11-4800 TCX', name: 'Blanc de Blanc', family: 'White', r: 239, g: 236, b: 227 },
  { code: '12-0607 TCX', name: 'Nordic Ice', family: 'White', r: 234, g: 233, b: 220 },
  { code: '12-0404 TCX', name: 'Nimbus Cloud', family: 'White', r: 228, g: 226, b: 214 },
  { code: '13-0000 TCX', name: 'White Alyssum', family: 'White', r: 230, g: 231, b: 222 },

  // ─── Gray / 灰（正装面料高频） ───
  { code: '14-4102 TCX', name: 'Micro Chip', family: 'Gray', r: 172, g: 173, b: 175 },
  { code: '16-3801 TCX', name: 'Gossamer Gray', family: 'Gray', r: 150, g: 152, b: 153 },
  { code: '17-3907 TCX', name: 'Neutral Gray', family: 'Gray', r: 139, g: 141, b: 139 },
  { code: '17-0000 TCX', name: 'Fashion Gray', family: 'Gray', r: 127, g: 128, b: 126 },
  { code: '18-0601 TCX', name: 'Charcoal Gray', family: 'Gray', r: 82, g: 84, b: 86 },
  { code: '19-3911 TCX', name: 'Graphite', family: 'Gray', r: 63, g: 68, b: 76 },
  { code: '18-5209 TCX', name: 'Slate Gray', family: 'Gray', r: 89, g: 99, b: 108 },

  // ─── Black / 黑 ───
  { code: '19-0303 TCX', name: 'Jet Black', family: 'Black', r: 30, g: 30, b: 34 },
  { code: '19-4205 TCX', name: 'Pirate Black', family: 'Black', r: 36, g: 36, b: 37 },

  // ─── Blue / 蓝（最大色系：牛仔/正装/功能面料） ───
  { code: '19-4052 TCX', name: 'Classic Blue', family: 'Blue', r: 0, g: 73, b: 144 },
  { code: '19-4024 TCX', name: 'Dark Denim', family: 'Blue', r: 0, g: 65, b: 108 },
  { code: '19-4318 TCX', name: 'Antarctic Blue', family: 'Blue', r: 50, g: 82, b: 110 },
  { code: '18-4045 TCX', name: 'Deep Water', family: 'Blue', r: 28, g: 98, b: 145 },
  { code: '18-4141 TCX', name: 'Vallarta Blue', family: 'Blue', r: 0, g: 110, b: 155 },
  { code: '17-4436 TCX', name: 'Marina', family: 'Blue', r: 62, g: 136, b: 166 },
  { code: '16-4132 TCX', name: 'Little Boy Blue', family: 'Blue', r: 108, g: 165, b: 205 },
  { code: '15-4020 TCX', name: 'Cerulean', family: 'Blue', r: 152, g: 180, b: 202 },
  { code: '14-4318 TCX', name: 'Serenity', family: 'Blue', r: 146, g: 168, b: 189 },
  { code: '13-4108 TCX', name: 'Powder Blue', family: 'Blue', r: 177, g: 199, b: 214 },
  { code: '18-4225 TCX', name: 'Moonlit Ocean', family: 'Blue', r: 42, g: 88, b: 116 },
  { code: '19-4340 TCX', name: 'Deep Sea', family: 'Blue', r: 26, g: 67, b: 92 },

  // ─── Navy / 藏青（正装核心色） ───
  { code: '19-4028 TCX', name: 'Estate Blue', family: 'Blue', r: 36, g: 54, b: 83 },
  { code: '19-4125 TCX', name: 'Sailor Blue', family: 'Blue', r: 25, g: 46, b: 77 },
  { code: '19-4241 TCX', name: 'Moonlit Navy', family: 'Blue', r: 31, g: 42, b: 62 },
  { code: '19-4150 TCX', name: 'Star Sapphire', family: 'Blue', r: 0, g: 48, b: 79 },

  // ─── Red / 红 ───
  { code: '19-1664 TCX', name: 'True Red', family: 'Red', r: 191, g: 24, b: 44 },
  { code: '18-1761 TCX', name: 'Tibetan Red', family: 'Red', r: 178, g: 42, b: 47 },
  { code: '18-1750 TCX', name: 'Viva Magenta', family: 'Red', r: 187, g: 52, b: 83 },
  { code: '17-1561 TCX', name: 'Grenadine', family: 'Red', r: 214, g: 69, b: 50 },
  { code: '17-1563 TCX', name: 'Mars Red', family: 'Red', r: 199, g: 58, b: 44 },
  { code: '16-1546 TCX', name: 'Living Coral', family: 'Red', r: 255, g: 111, b: 97 },
  { code: '16-1659 TCX', name: 'Ribbon Red', family: 'Red', r: 200, g: 47, b: 55 },
  { code: '19-1557 TCX', name: 'Chili Pepper', family: 'Red', r: 155, g: 27, b: 34 },
  { code: '18-1438 TCX', name: 'Marsala', family: 'Red', r: 150, g: 79, b: 63 },
  { code: '19-1662 TCX', name: 'Jester Red', family: 'Red', r: 155, g: 32, b: 41 },

  // ─── Pink / 粉 ───
  { code: '13-1520 TCX', name: 'Rose Quartz', family: 'Pink', r: 242, g: 220, b: 222 },
  { code: '15-1922 TCX', name: 'Blooming Dahlia', family: 'Pink', r: 235, g: 172, b: 172 },
  { code: '16-1716 TCX', name: 'Coral Pink', family: 'Pink', r: 234, g: 141, b: 141 },
  { code: '17-1937 TCX', name: 'Strawberry Ice', family: 'Pink', r: 227, g: 123, b: 131 },
  { code: '18-2043 TCX', name: 'Pink Flambé', family: 'Pink', r: 206, g: 87, b: 111 },
  { code: '14-1907 TCX', name: 'Blossom', family: 'Pink', r: 238, g: 205, b: 205 },
  { code: '15-1817 TCX', name: 'Cloud Pink', family: 'Pink', r: 236, g: 189, b: 187 },
  { code: '16-2131 TCX', name: 'Geranium Pink', family: 'Pink', r: 226, g: 122, b: 133 },

  // ─── Orange / 橙 ───
  { code: '16-1544 TCX', name: 'Tangerine Tango', family: 'Orange', r: 227, g: 88, b: 47 },
  { code: '17-1462 TCX', name: 'Flame Scarlet', family: 'Orange', r: 218, g: 76, b: 42 },
  { code: '18-1441 TCX', name: 'Rooibos Tea', family: 'Orange', r: 183, g: 71, b: 48 },
  { code: '16-1364 TCX', name: 'Orange Tiger', family: 'Orange', r: 236, g: 113, b: 52 },
  { code: '15-1160 TCX', name: 'Turmeric', family: 'Orange', r: 240, g: 147, b: 43 },

  // ─── Yellow / 黄 ───
  { code: '13-0850 TCX', name: 'Illuminating', family: 'Yellow', r: 245, g: 210, b: 63 },
  { code: '15-1058 TCX', name: 'Cyber Yellow', family: 'Yellow', r: 243, g: 184, b: 30 },
  { code: '12-0752 TCX', name: 'Buttercup', family: 'Yellow', r: 250, g: 218, b: 104 },
  { code: '14-0952 TCX', name: 'Argan Oil', family: 'Yellow', r: 229, g: 182, b: 59 },
  { code: '13-0648 TCX', name: 'Lemon Zest', family: 'Yellow', r: 245, g: 202, b: 43 },

  // ─── Green / 绿 ───
  { code: '15-0343 TCX', name: 'Greenery', family: 'Green', r: 136, g: 176, b: 75 },
  { code: '17-6153 TCX', name: 'Emerald', family: 'Green', r: 0, g: 147, b: 106 },
  { code: '18-5619 TCX', name: 'Billiard Green', family: 'Green', r: 28, g: 111, b: 80 },
  { code: '19-0323 TCX', name: 'Rifle Green', family: 'Green', r: 66, g: 83, b: 59 },
  { code: '16-0439 TCX', name: 'Fern Green', family: 'Green', r: 96, g: 130, b: 72 },
  { code: '14-0156 TCX', name: 'Leprechaun', family: 'Green', r: 116, g: 169, b: 82 },
  { code: '17-5741 TCX', name: 'Amazon', family: 'Green', r: 60, g: 119, b: 92 },
  { code: '19-5412 TCX', name: 'Deep Forest', family: 'Green', r: 21, g: 71, b: 66 },
  { code: '15-6341 TCX', name: 'Jade Green', family: 'Green', r: 35, g: 151, b: 125 },

  // ─── Teal / 青蓝 ───
  { code: '18-4726 TCX', name: 'Deep Teal', family: 'Teal', r: 27, g: 124, b: 125 },
  { code: '15-5217 TCX', name: 'Turkish Tile', family: 'Teal', r: 39, g: 155, b: 158 },
  { code: '16-5412 TCX', name: 'Blue Turquoise', family: 'Teal', r: 64, g: 165, b: 168 },
  { code: '14-5711 TCX', name: 'Beveled Glass', family: 'Teal', r: 130, g: 190, b: 183 },

  // ─── Purple / 紫 ───
  { code: '18-3838 TCX', name: 'Ultra Violet', family: 'Purple', r: 95, g: 75, b: 139 },
  { code: '17-3938 TCX', name: 'Very Peri', family: 'Purple', r: 134, g: 116, b: 171 },
  { code: '16-3520 TCX', name: 'Fuchsia Purple', family: 'Purple', r: 150, g: 88, b: 153 },
  { code: '19-3536 TCX', name: 'Grape Compote', family: 'Purple', r: 88, g: 68, b: 105 },
  { code: '15-3718 TCX', name: 'Heir Lilac', family: 'Purple', r: 174, g: 147, b: 188 },
  { code: '18-3339 TCX', name: 'Royal Lilac', family: 'Purple', r: 130, g: 91, b: 139 },
  { code: '17-3628 TCX', name: 'Amethyst Orchid', family: 'Purple', r: 144, g: 84, b: 148 },

  // ─── Brown / 棕（面料大地色高频） ───
  { code: '17-1230 TCX', name: 'Mocha Mousse', family: 'Brown', r: 166, g: 117, b: 94 },
  { code: '19-1016 TCX', name: 'Deep Taupe', family: 'Brown', r: 84, g: 71, b: 62 },
  { code: '18-1027 TCX', name: 'Burnt Olive', family: 'Brown', r: 128, g: 93, b: 63 },
  { code: '16-1328 TCX', name: 'Heathered Brown', family: 'Brown', r: 158, g: 131, b: 111 },
  { code: '15-1214 TCX', name: 'Autumn Blonde', family: 'Brown', r: 189, g: 163, b: 132 },
  { code: '17-1040 TCX', name: 'Sedge', family: 'Brown', r: 157, g: 121, b: 71 },
  { code: '19-1116 TCX', name: 'Coffee Bean', family: 'Brown', r: 95, g: 74, b: 61 },
  { code: '18-1173 TCX', name: 'Toast', family: 'Brown', r: 166, g: 119, b: 77 },
  { code: '14-1116 TCX', name: 'Sand Dollar', family: 'Brown', r: 219, g: 202, b: 178 },
  { code: '16-1220 TCX', name: 'Warm Taupe', family: 'Brown', r: 166, g: 141, b: 119 },
  { code: '19-1213 TCX', name: 'Bark', family: 'Brown', r: 108, g: 84, b: 68 },

  // ─── Beige / 米（天然面料底色） ───
  { code: '12-0605 TCX', name: 'Cloud Dancer', family: 'Beige', r: 240, g: 237, b: 228 },
  { code: '13-0908 TCX', name: 'Almond', family: 'Beige', r: 227, g: 205, b: 168 },
  { code: '14-1112 TCX', name: 'Bone White', family: 'Beige', r: 228, g: 212, b: 187 },
  { code: '13-1006 TCX', name: 'Oatmeal', family: 'Beige', r: 217, g: 191, b: 156 },
  { code: '15-1215 TCX', name: 'Tender Peach', family: 'Beige', r: 229, g: 195, b: 174 },
  { code: '16-1221 TCX', name: 'Tumbleweed', family: 'Beige', r: 216, g: 175, b: 139 },

  // ─── Khaki / 卡其（工装面料） ───
  { code: '16-0713 TCX', name: 'Army Olive', family: 'Khaki', r: 100, g: 104, b: 61 },
  { code: '17-0625 TCX', name: 'Kombu Green', family: 'Khaki', r: 104, g: 103, b: 66 },
  { code: '19-0426 TCX', name: 'Field Green', family: 'Khaki', r: 75, g: 83, b: 56 },
  { code: '18-0332 TCX', name: 'Moss Green', family: 'Khaki', r: 104, g: 113, b: 76 },
  { code: '16-0526 TCX', name: 'Fern', family: 'Khaki', r: 111, g: 118, b: 76 },

  // ─── Burgundy / 酒红（正装） ───
  { code: '19-1718 TCX', name: 'Sangria', family: 'Burgundy', r: 110, g: 29, b: 49 },
  { code: '19-1531 TCX', name: 'Bordeaux', family: 'Burgundy', r: 100, g: 30, b: 44 },
  { code: '18-1740 TCX', name: 'Scarlet Sage', family: 'Burgundy', r: 140, g: 41, b: 60 },
  { code: '19-1720 TCX', name: 'Velvet Coffee', family: 'Burgundy', r: 106, g: 40, b: 51 },

  // ─── 年度色补充（客户常引用；与上文色系区重复的不再收录） ───
  { code: '13-1023 TCX', name: 'Peach Fuzz', family: 'Pink', r: 255, g: 190, b: 152 },
  { code: '15-1247 TCX', name: 'Mimosa', family: 'Yellow', r: 240, g: 200, b: 100 },
  { code: '17-5104 TCX', name: 'Ultimate Gray', family: 'Gray', r: 136, g: 136, b: 134 },
  { code: '13-0647 TCX', name: 'Illuminating', family: 'Yellow', r: 245, g: 205, b: 45 },
];
