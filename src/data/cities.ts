export type City = {
  code: string
  name_ja: string
  prefecture: string
  lat: number
  lng: number
  airport_iata: string | null
  shinkansen_station_codes: string[]
}

export const CITIES: City[] = [
  {
    code: 'sapporo',
    name_ja: '札幌',
    prefecture: '北海道',
    lat: 43.0618,
    lng: 141.3545,
    airport_iata: 'CTS',
    shinkansen_station_codes: []
  },
  {
    code: 'asahikawa',
    name_ja: '旭川',
    prefecture: '北海道',
    lat: 43.7706,
    lng: 142.365,
    airport_iata: 'AKJ',
    shinkansen_station_codes: []
  },
  {
    code: 'kushiro',
    name_ja: '釧路',
    prefecture: '北海道',
    lat: 42.9849,
    lng: 144.3819,
    airport_iata: 'KUH',
    shinkansen_station_codes: []
  },
  {
    code: 'obihiro',
    name_ja: '帯広',
    prefecture: '北海道',
    lat: 42.9241,
    lng: 143.1969,
    airport_iata: 'OBO',
    shinkansen_station_codes: []
  },
  {
    code: 'memanbetsu',
    name_ja: '網走 (女満別)',
    prefecture: '北海道',
    lat: 43.8806,
    lng: 144.164,
    airport_iata: 'MMB',
    shinkansen_station_codes: []
  },
  {
    code: 'wakkanai',
    name_ja: '稚内',
    prefecture: '北海道',
    lat: 45.4083,
    lng: 141.6731,
    airport_iata: 'WKJ',
    shinkansen_station_codes: []
  },
  {
    code: 'hakodate',
    name_ja: '函館',
    prefecture: '北海道',
    lat: 41.7687,
    lng: 140.7288,
    airport_iata: 'HKD',
    shinkansen_station_codes: ['shin_hakodate_hokuto']
  },

  {
    code: 'aomori',
    name_ja: '青森',
    prefecture: '青森県',
    lat: 40.8244,
    lng: 140.74,
    airport_iata: 'AOJ',
    shinkansen_station_codes: ['shin_aomori']
  },
  {
    code: 'hachinohe',
    name_ja: '八戸',
    prefecture: '青森県',
    lat: 40.5121,
    lng: 141.4882,
    airport_iata: null,
    shinkansen_station_codes: ['hachinohe']
  },
  {
    code: 'morioka',
    name_ja: '盛岡',
    prefecture: '岩手県',
    lat: 39.7036,
    lng: 141.1527,
    airport_iata: 'HNA',
    shinkansen_station_codes: ['morioka', 'morioka_akita']
  },
  {
    code: 'akita',
    name_ja: '秋田',
    prefecture: '秋田県',
    lat: 39.7186,
    lng: 140.1024,
    airport_iata: 'AXT',
    shinkansen_station_codes: ['akita']
  },
  {
    code: 'sendai',
    name_ja: '仙台',
    prefecture: '宮城県',
    lat: 38.2682,
    lng: 140.8694,
    airport_iata: 'SDJ',
    shinkansen_station_codes: ['sendai']
  },
  {
    code: 'yamagata',
    name_ja: '山形',
    prefecture: '山形県',
    lat: 38.2403,
    lng: 140.3636,
    airport_iata: 'GAJ',
    shinkansen_station_codes: ['yamagata']
  },
  {
    code: 'shonai',
    name_ja: '庄内 (鶴岡)',
    prefecture: '山形県',
    lat: 38.8121,
    lng: 139.7873,
    airport_iata: 'SYO',
    shinkansen_station_codes: []
  },
  {
    code: 'fukushima',
    name_ja: '福島',
    prefecture: '福島県',
    lat: 37.7503,
    lng: 140.4677,
    airport_iata: 'FKS',
    shinkansen_station_codes: ['fukushima', 'fukushima_yamagata']
  },
  {
    code: 'koriyama',
    name_ja: '郡山',
    prefecture: '福島県',
    lat: 37.4001,
    lng: 140.3597,
    airport_iata: null,
    shinkansen_station_codes: ['koriyama']
  },

  {
    code: 'mito',
    name_ja: '水戸',
    prefecture: '茨城県',
    lat: 36.3418,
    lng: 140.4468,
    airport_iata: 'IBR',
    shinkansen_station_codes: []
  },
  {
    code: 'utsunomiya',
    name_ja: '宇都宮',
    prefecture: '栃木県',
    lat: 36.5658,
    lng: 139.8836,
    airport_iata: null,
    shinkansen_station_codes: ['utsunomiya']
  },
  {
    code: 'maebashi',
    name_ja: '前橋',
    prefecture: '群馬県',
    lat: 36.3895,
    lng: 139.0634,
    airport_iata: null,
    shinkansen_station_codes: ['takasaki', 'takasaki_hokuriku']
  },
  {
    code: 'omiya',
    name_ja: 'さいたま (大宮)',
    prefecture: '埼玉県',
    lat: 35.9061,
    lng: 139.6238,
    airport_iata: null,
    shinkansen_station_codes: ['omiya', 'omiya_joetsu']
  },
  {
    code: 'chiba',
    name_ja: '千葉',
    prefecture: '千葉県',
    lat: 35.6074,
    lng: 140.1065,
    airport_iata: 'NRT',
    shinkansen_station_codes: []
  },
  {
    code: 'tokyo',
    name_ja: '東京',
    prefecture: '東京都',
    lat: 35.6812,
    lng: 139.7671,
    airport_iata: 'HND',
    shinkansen_station_codes: ['tokyo', 'tokyo_tohoku']
  },
  {
    code: 'yokohama',
    name_ja: '横浜',
    prefecture: '神奈川県',
    lat: 35.4437,
    lng: 139.638,
    airport_iata: null,
    shinkansen_station_codes: ['shin_yokohama']
  },
  {
    code: 'odawara',
    name_ja: '小田原',
    prefecture: '神奈川県',
    lat: 35.2563,
    lng: 139.1554,
    airport_iata: null,
    shinkansen_station_codes: ['odawara']
  },

  {
    code: 'niigata',
    name_ja: '新潟',
    prefecture: '新潟県',
    lat: 37.9026,
    lng: 139.0234,
    airport_iata: 'KIJ',
    shinkansen_station_codes: ['niigata']
  },
  {
    code: 'nagaoka',
    name_ja: '長岡',
    prefecture: '新潟県',
    lat: 37.4458,
    lng: 138.8516,
    airport_iata: null,
    shinkansen_station_codes: ['nagaoka']
  },
  {
    code: 'toyama',
    name_ja: '富山',
    prefecture: '富山県',
    lat: 36.6953,
    lng: 137.2113,
    airport_iata: 'TOY',
    shinkansen_station_codes: ['toyama']
  },
  {
    code: 'kanazawa',
    name_ja: '金沢',
    prefecture: '石川県',
    lat: 36.5613,
    lng: 136.6562,
    airport_iata: 'KMQ',
    shinkansen_station_codes: ['kanazawa']
  },
  {
    code: 'noto',
    name_ja: '能登',
    prefecture: '石川県',
    lat: 37.2937,
    lng: 136.9619,
    airport_iata: 'NTQ',
    shinkansen_station_codes: []
  },
  {
    code: 'fukui',
    name_ja: '福井',
    prefecture: '福井県',
    lat: 36.0641,
    lng: 136.2196,
    airport_iata: null,
    shinkansen_station_codes: ['fukui']
  },
  {
    code: 'tsuruga',
    name_ja: '敦賀',
    prefecture: '福井県',
    lat: 35.6453,
    lng: 136.0556,
    airport_iata: null,
    shinkansen_station_codes: ['tsuruga']
  },

  {
    code: 'kofu',
    name_ja: '甲府',
    prefecture: '山梨県',
    lat: 35.6638,
    lng: 138.5683,
    airport_iata: null,
    shinkansen_station_codes: []
  },
  {
    code: 'nagano',
    name_ja: '長野',
    prefecture: '長野県',
    lat: 36.6485,
    lng: 138.1948,
    airport_iata: null,
    shinkansen_station_codes: ['nagano']
  },
  {
    code: 'matsumoto',
    name_ja: '松本',
    prefecture: '長野県',
    lat: 36.2381,
    lng: 137.972,
    airport_iata: 'MMJ',
    shinkansen_station_codes: []
  },
  {
    code: 'karuizawa',
    name_ja: '軽井沢',
    prefecture: '長野県',
    lat: 36.3486,
    lng: 138.5968,
    airport_iata: null,
    shinkansen_station_codes: ['karuizawa']
  },
  {
    code: 'shizuoka',
    name_ja: '静岡',
    prefecture: '静岡県',
    lat: 34.9756,
    lng: 138.3829,
    airport_iata: 'FSZ',
    shinkansen_station_codes: ['shizuoka']
  },
  {
    code: 'hamamatsu',
    name_ja: '浜松',
    prefecture: '静岡県',
    lat: 34.7108,
    lng: 137.7261,
    airport_iata: null,
    shinkansen_station_codes: ['hamamatsu']
  },
  {
    code: 'gifu',
    name_ja: '岐阜',
    prefecture: '岐阜県',
    lat: 35.4232,
    lng: 136.761,
    airport_iata: null,
    shinkansen_station_codes: ['gifu_hashima']
  },
  {
    code: 'nagoya',
    name_ja: '名古屋',
    prefecture: '愛知県',
    lat: 35.1815,
    lng: 136.9066,
    airport_iata: 'NGO',
    shinkansen_station_codes: ['nagoya']
  },
  {
    code: 'tsu',
    name_ja: '津',
    prefecture: '三重県',
    lat: 34.7184,
    lng: 136.5057,
    airport_iata: null,
    shinkansen_station_codes: []
  },

  {
    code: 'otsu',
    name_ja: '大津',
    prefecture: '滋賀県',
    lat: 35.0045,
    lng: 135.8686,
    airport_iata: null,
    shinkansen_station_codes: ['maibara']
  },
  {
    code: 'kyoto',
    name_ja: '京都',
    prefecture: '京都府',
    lat: 35.0116,
    lng: 135.7681,
    airport_iata: null,
    shinkansen_station_codes: ['kyoto']
  },
  {
    code: 'osaka',
    name_ja: '大阪',
    prefecture: '大阪府',
    lat: 34.6937,
    lng: 135.5023,
    airport_iata: 'ITM',
    shinkansen_station_codes: ['shin_osaka']
  },
  {
    code: 'kansai',
    name_ja: '関西国際空港',
    prefecture: '大阪府',
    lat: 34.4347,
    lng: 135.244,
    airport_iata: 'KIX',
    shinkansen_station_codes: []
  },
  {
    code: 'kobe',
    name_ja: '神戸',
    prefecture: '兵庫県',
    lat: 34.6901,
    lng: 135.1955,
    airport_iata: 'UKB',
    shinkansen_station_codes: ['shin_kobe']
  },
  {
    code: 'himeji',
    name_ja: '姫路',
    prefecture: '兵庫県',
    lat: 34.8395,
    lng: 134.6939,
    airport_iata: null,
    shinkansen_station_codes: ['himeji']
  },
  {
    code: 'tajima',
    name_ja: '但馬 (豊岡)',
    prefecture: '兵庫県',
    lat: 35.5128,
    lng: 134.7866,
    airport_iata: 'TJH',
    shinkansen_station_codes: []
  },
  {
    code: 'nara',
    name_ja: '奈良',
    prefecture: '奈良県',
    lat: 34.6851,
    lng: 135.8048,
    airport_iata: null,
    shinkansen_station_codes: []
  },
  {
    code: 'wakayama',
    name_ja: '和歌山',
    prefecture: '和歌山県',
    lat: 34.2261,
    lng: 135.1675,
    airport_iata: 'SHM',
    shinkansen_station_codes: []
  },

  {
    code: 'tottori',
    name_ja: '鳥取',
    prefecture: '鳥取県',
    lat: 35.5022,
    lng: 134.2354,
    airport_iata: 'TTJ',
    shinkansen_station_codes: []
  },
  {
    code: 'yonago',
    name_ja: '米子',
    prefecture: '鳥取県',
    lat: 35.4282,
    lng: 133.3309,
    airport_iata: 'YGJ',
    shinkansen_station_codes: []
  },
  {
    code: 'matsue',
    name_ja: '松江',
    prefecture: '島根県',
    lat: 35.4723,
    lng: 133.0508,
    airport_iata: 'IZO',
    shinkansen_station_codes: []
  },
  {
    code: 'iwami',
    name_ja: '石見',
    prefecture: '島根県',
    lat: 34.6764,
    lng: 131.79,
    airport_iata: 'IWJ',
    shinkansen_station_codes: []
  },
  {
    code: 'okayama',
    name_ja: '岡山',
    prefecture: '岡山県',
    lat: 34.6618,
    lng: 133.9344,
    airport_iata: 'OKJ',
    shinkansen_station_codes: ['okayama']
  },
  {
    code: 'hiroshima',
    name_ja: '広島',
    prefecture: '広島県',
    lat: 34.3853,
    lng: 132.4553,
    airport_iata: 'HIJ',
    shinkansen_station_codes: ['hiroshima']
  },
  {
    code: 'fukuyama',
    name_ja: '福山',
    prefecture: '広島県',
    lat: 34.4858,
    lng: 133.3625,
    airport_iata: null,
    shinkansen_station_codes: ['fukuyama']
  },
  {
    code: 'iwakuni',
    name_ja: '岩国',
    prefecture: '山口県',
    lat: 34.1668,
    lng: 132.2356,
    airport_iata: 'IWK',
    shinkansen_station_codes: ['shin_iwakuni']
  },
  {
    code: 'yamaguchi',
    name_ja: '山口',
    prefecture: '山口県',
    lat: 34.1859,
    lng: 131.4714,
    airport_iata: 'UBJ',
    shinkansen_station_codes: ['shin_yamaguchi']
  },

  {
    code: 'tokushima',
    name_ja: '徳島',
    prefecture: '徳島県',
    lat: 34.0658,
    lng: 134.5593,
    airport_iata: 'TKS',
    shinkansen_station_codes: []
  },
  {
    code: 'takamatsu',
    name_ja: '高松',
    prefecture: '香川県',
    lat: 34.3401,
    lng: 134.0434,
    airport_iata: 'TAK',
    shinkansen_station_codes: []
  },
  {
    code: 'matsuyama',
    name_ja: '松山',
    prefecture: '愛媛県',
    lat: 33.8392,
    lng: 132.7657,
    airport_iata: 'MYJ',
    shinkansen_station_codes: []
  },
  {
    code: 'kochi',
    name_ja: '高知',
    prefecture: '高知県',
    lat: 33.5597,
    lng: 133.5311,
    airport_iata: 'KCZ',
    shinkansen_station_codes: []
  },

  {
    code: 'kitakyushu',
    name_ja: '北九州',
    prefecture: '福岡県',
    lat: 33.8835,
    lng: 130.8751,
    airport_iata: 'KKJ',
    shinkansen_station_codes: ['kokura']
  },
  {
    code: 'fukuoka',
    name_ja: '福岡',
    prefecture: '福岡県',
    lat: 33.5904,
    lng: 130.4017,
    airport_iata: 'FUK',
    shinkansen_station_codes: ['hakata']
  },
  {
    code: 'saga',
    name_ja: '佐賀',
    prefecture: '佐賀県',
    lat: 33.2494,
    lng: 130.2989,
    airport_iata: 'HSG',
    shinkansen_station_codes: ['shin_tosu']
  },
  {
    code: 'nagasaki',
    name_ja: '長崎',
    prefecture: '長崎県',
    lat: 32.7503,
    lng: 129.8779,
    airport_iata: 'NGS',
    shinkansen_station_codes: ['nagasaki']
  },
  {
    code: 'tsushima',
    name_ja: '対馬',
    prefecture: '長崎県',
    lat: 34.2848,
    lng: 129.3303,
    airport_iata: 'TSJ',
    shinkansen_station_codes: []
  },
  {
    code: 'fukue',
    name_ja: '福江 (五島)',
    prefecture: '長崎県',
    lat: 32.6663,
    lng: 128.8329,
    airport_iata: 'FUJ',
    shinkansen_station_codes: []
  },
  {
    code: 'kumamoto',
    name_ja: '熊本',
    prefecture: '熊本県',
    lat: 32.8032,
    lng: 130.7079,
    airport_iata: 'KMJ',
    shinkansen_station_codes: ['kumamoto']
  },
  {
    code: 'amakusa',
    name_ja: '天草',
    prefecture: '熊本県',
    lat: 32.4823,
    lng: 130.1591,
    airport_iata: 'AXJ',
    shinkansen_station_codes: []
  },
  {
    code: 'oita',
    name_ja: '大分',
    prefecture: '大分県',
    lat: 33.2382,
    lng: 131.6126,
    airport_iata: 'OIT',
    shinkansen_station_codes: []
  },
  {
    code: 'miyazaki',
    name_ja: '宮崎',
    prefecture: '宮崎県',
    lat: 31.9077,
    lng: 131.4202,
    airport_iata: 'KMI',
    shinkansen_station_codes: []
  },
  {
    code: 'kagoshima',
    name_ja: '鹿児島',
    prefecture: '鹿児島県',
    lat: 31.5966,
    lng: 130.5571,
    airport_iata: 'KOJ',
    shinkansen_station_codes: ['kagoshima_chuo']
  },
  {
    code: 'yakushima',
    name_ja: '屋久島',
    prefecture: '鹿児島県',
    lat: 30.3856,
    lng: 130.6589,
    airport_iata: 'KUM',
    shinkansen_station_codes: []
  },
  {
    code: 'amami',
    name_ja: '奄美',
    prefecture: '鹿児島県',
    lat: 28.4306,
    lng: 129.7126,
    airport_iata: 'ASJ',
    shinkansen_station_codes: []
  },

  {
    code: 'naha',
    name_ja: '那覇',
    prefecture: '沖縄県',
    lat: 26.2124,
    lng: 127.6809,
    airport_iata: 'OKA',
    shinkansen_station_codes: []
  },
  {
    code: 'ishigaki',
    name_ja: '石垣',
    prefecture: '沖縄県',
    lat: 24.3964,
    lng: 124.245,
    airport_iata: 'ISG',
    shinkansen_station_codes: []
  },
  {
    code: 'miyako',
    name_ja: '宮古',
    prefecture: '沖縄県',
    lat: 24.7828,
    lng: 125.2949,
    airport_iata: 'MMY',
    shinkansen_station_codes: []
  }
]

export const CITY_BY_CODE = new Map(CITIES.map((c) => [c.code, c] as const))

export function findCity(code: string): City | undefined {
  return CITY_BY_CODE.get(code)
}

export function haversineKm(a: City, b: City): number {
  const R = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}
