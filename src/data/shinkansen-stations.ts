export type ShinkansenCorridor =
  | 'tokaido_sanyo_kyushu'
  | 'tohoku_hokkaido'
  | 'joetsu'
  | 'hokuriku'
  | 'yamagata'
  | 'akita'
  | 'nishi_kyushu'

export type ShinkansenStation = {
  code: string
  name_ja: string
  corridor: ShinkansenCorridor
  km_from_origin: number
}

export const SHINKANSEN_STATIONS: ShinkansenStation[] = [
  { code: 'tokyo', name_ja: '東京', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 0 },
  { code: 'shinagawa', name_ja: '品川', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 6.8 },
  { code: 'shin_yokohama', name_ja: '新横浜', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 28.8 },
  { code: 'odawara', name_ja: '小田原', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 83.9 },
  { code: 'atami', name_ja: '熱海', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 104.6 },
  { code: 'mishima', name_ja: '三島', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 120.7 },
  { code: 'shin_fuji', name_ja: '新富士', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 146.2 },
  { code: 'shizuoka', name_ja: '静岡', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 180.2 },
  { code: 'kakegawa', name_ja: '掛川', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 229.3 },
  { code: 'hamamatsu', name_ja: '浜松', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 257.1 },
  { code: 'toyohashi', name_ja: '豊橋', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 293.6 },
  { code: 'mikawa_anjo', name_ja: '三河安城', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 336.3 },
  { code: 'nagoya', name_ja: '名古屋', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 366.0 },
  { code: 'gifu_hashima', name_ja: '岐阜羽島', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 396.3 },
  { code: 'maibara', name_ja: '米原', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 445.9 },
  { code: 'kyoto', name_ja: '京都', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 513.6 },
  { code: 'shin_osaka', name_ja: '新大阪', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 552.6 },
  { code: 'shin_kobe', name_ja: '新神戸', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 589.5 },
  { code: 'nishi_akashi', name_ja: '西明石', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 612.3 },
  { code: 'himeji', name_ja: '姫路', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 644.3 },
  { code: 'aioi', name_ja: '相生', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 666.7 },
  { code: 'okayama', name_ja: '岡山', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 732.9 },
  { code: 'shin_kurashiki', name_ja: '新倉敷', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 758.1 },
  { code: 'fukuyama', name_ja: '福山', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 791.2 },
  { code: 'shin_onomichi', name_ja: '新尾道', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 810.2 },
  { code: 'mihara', name_ja: '三原', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 827.0 },
  { code: 'higashi_hiroshima', name_ja: '東広島', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 870.6 },
  { code: 'hiroshima', name_ja: '広島', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 894.2 },
  { code: 'shin_iwakuni', name_ja: '新岩国', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 935.1 },
  { code: 'tokuyama', name_ja: '徳山', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 992.1 },
  { code: 'shin_yamaguchi', name_ja: '新山口', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1027.0 },
  { code: 'asa', name_ja: '厚狭', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1054.2 },
  { code: 'shin_shimonoseki', name_ja: '新下関', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1075.9 },
  { code: 'kokura', name_ja: '小倉', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1107.7 },
  { code: 'hakata', name_ja: '博多', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1174.9 },
  { code: 'shin_tosu', name_ja: '新鳥栖', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1203.9 },
  { code: 'kurume', name_ja: '久留米', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1216.5 },
  { code: 'chikugo_funagoya', name_ja: '筑後船小屋', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1232.7 },
  { code: 'shin_omuta', name_ja: '新大牟田', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1254.5 },
  { code: 'shin_tamana', name_ja: '新玉名', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1272.6 },
  { code: 'kumamoto', name_ja: '熊本', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1300.4 },
  { code: 'shin_yatsushiro', name_ja: '新八代', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1335.3 },
  { code: 'shin_minamata', name_ja: '新水俣', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1374.3 },
  { code: 'izumi', name_ja: '出水', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1394.4 },
  { code: 'sendai_kagoshima', name_ja: '川内', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1431.1 },
  { code: 'kagoshima_chuo', name_ja: '鹿児島中央', corridor: 'tokaido_sanyo_kyushu', km_from_origin: 1463.5 },

  { code: 'tokyo_tohoku', name_ja: '東京', corridor: 'tohoku_hokkaido', km_from_origin: 0 },
  { code: 'ueno', name_ja: '上野', corridor: 'tohoku_hokkaido', km_from_origin: 3.6 },
  { code: 'omiya', name_ja: '大宮', corridor: 'tohoku_hokkaido', km_from_origin: 30.3 },
  { code: 'oyama', name_ja: '小山', corridor: 'tohoku_hokkaido', km_from_origin: 80.6 },
  { code: 'utsunomiya', name_ja: '宇都宮', corridor: 'tohoku_hokkaido', km_from_origin: 109.5 },
  { code: 'nasu_shiobara', name_ja: '那須塩原', corridor: 'tohoku_hokkaido', km_from_origin: 157.8 },
  { code: 'shin_shirakawa', name_ja: '新白河', corridor: 'tohoku_hokkaido', km_from_origin: 185.4 },
  { code: 'koriyama', name_ja: '郡山', corridor: 'tohoku_hokkaido', km_from_origin: 226.7 },
  { code: 'fukushima', name_ja: '福島', corridor: 'tohoku_hokkaido', km_from_origin: 272.8 },
  { code: 'shiroishi_zao', name_ja: '白石蔵王', corridor: 'tohoku_hokkaido', km_from_origin: 306.8 },
  { code: 'sendai', name_ja: '仙台', corridor: 'tohoku_hokkaido', km_from_origin: 351.8 },
  { code: 'furukawa', name_ja: '古川', corridor: 'tohoku_hokkaido', km_from_origin: 395.0 },
  { code: 'kurikoma_kogen', name_ja: 'くりこま高原', corridor: 'tohoku_hokkaido', km_from_origin: 416.2 },
  { code: 'ichinoseki', name_ja: '一ノ関', corridor: 'tohoku_hokkaido', km_from_origin: 445.1 },
  { code: 'mizusawa_esashi', name_ja: '水沢江刺', corridor: 'tohoku_hokkaido', km_from_origin: 470.1 },
  { code: 'kitakami', name_ja: '北上', corridor: 'tohoku_hokkaido', km_from_origin: 487.5 },
  { code: 'shin_hanamaki', name_ja: '新花巻', corridor: 'tohoku_hokkaido', km_from_origin: 500.0 },
  { code: 'morioka', name_ja: '盛岡', corridor: 'tohoku_hokkaido', km_from_origin: 535.3 },
  { code: 'iwate_numakunai', name_ja: 'いわて沼宮内', corridor: 'tohoku_hokkaido', km_from_origin: 566.4 },
  { code: 'ninohe', name_ja: '二戸', corridor: 'tohoku_hokkaido', km_from_origin: 601.0 },
  { code: 'hachinohe', name_ja: '八戸', corridor: 'tohoku_hokkaido', km_from_origin: 631.9 },
  { code: 'shichinohe_towada', name_ja: '七戸十和田', corridor: 'tohoku_hokkaido', km_from_origin: 668.0 },
  { code: 'shin_aomori', name_ja: '新青森', corridor: 'tohoku_hokkaido', km_from_origin: 713.7 },
  { code: 'okutsugaru_imabetsu', name_ja: '奥津軽いまべつ', corridor: 'tohoku_hokkaido', km_from_origin: 752.0 },
  { code: 'kikonai', name_ja: '木古内', corridor: 'tohoku_hokkaido', km_from_origin: 823.7 },
  { code: 'shin_hakodate_hokuto', name_ja: '新函館北斗', corridor: 'tohoku_hokkaido', km_from_origin: 862.5 },

  { code: 'omiya_joetsu', name_ja: '大宮', corridor: 'joetsu', km_from_origin: 0 },
  { code: 'kumagaya', name_ja: '熊谷', corridor: 'joetsu', km_from_origin: 34.4 },
  { code: 'honjo_waseda', name_ja: '本庄早稲田', corridor: 'joetsu', km_from_origin: 55.7 },
  { code: 'takasaki', name_ja: '高崎', corridor: 'joetsu', km_from_origin: 74.7 },
  { code: 'jomo_kogen', name_ja: '上毛高原', corridor: 'joetsu', km_from_origin: 121.3 },
  { code: 'echigo_yuzawa', name_ja: '越後湯沢', corridor: 'joetsu', km_from_origin: 168.9 },
  { code: 'urasa', name_ja: '浦佐', corridor: 'joetsu', km_from_origin: 198.6 },
  { code: 'nagaoka', name_ja: '長岡', corridor: 'joetsu', km_from_origin: 240.3 },
  { code: 'tsubame_sanjo', name_ja: '燕三条', corridor: 'joetsu', km_from_origin: 263.5 },
  { code: 'niigata', name_ja: '新潟', corridor: 'joetsu', km_from_origin: 303.6 },

  { code: 'takasaki_hokuriku', name_ja: '高崎', corridor: 'hokuriku', km_from_origin: 0 },
  { code: 'annaka_haruna', name_ja: '安中榛名', corridor: 'hokuriku', km_from_origin: 18.5 },
  { code: 'karuizawa', name_ja: '軽井沢', corridor: 'hokuriku', km_from_origin: 41.8 },
  { code: 'sakudaira', name_ja: '佐久平', corridor: 'hokuriku', km_from_origin: 59.4 },
  { code: 'ueda', name_ja: '上田', corridor: 'hokuriku', km_from_origin: 84.2 },
  { code: 'nagano', name_ja: '長野', corridor: 'hokuriku', km_from_origin: 117.4 },
  { code: 'iiyama', name_ja: '飯山', corridor: 'hokuriku', km_from_origin: 147.3 },
  { code: 'joetsu_myoko', name_ja: '上越妙高', corridor: 'hokuriku', km_from_origin: 176.9 },
  { code: 'itoigawa', name_ja: '糸魚川', corridor: 'hokuriku', km_from_origin: 213.9 },
  { code: 'kurobe_unazukionsen', name_ja: '黒部宇奈月温泉', corridor: 'hokuriku', km_from_origin: 253.1 },
  { code: 'toyama', name_ja: '富山', corridor: 'hokuriku', km_from_origin: 286.9 },
  { code: 'shin_takaoka', name_ja: '新高岡', corridor: 'hokuriku', km_from_origin: 305.8 },
  { code: 'kanazawa', name_ja: '金沢', corridor: 'hokuriku', km_from_origin: 345.5 },
  { code: 'komatsu', name_ja: '小松', corridor: 'hokuriku', km_from_origin: 373.3 },
  { code: 'kaga_onsen', name_ja: '加賀温泉', corridor: 'hokuriku', km_from_origin: 387.7 },
  { code: 'awara_onsen', name_ja: '芦原温泉', corridor: 'hokuriku', km_from_origin: 412.9 },
  { code: 'fukui', name_ja: '福井', corridor: 'hokuriku', km_from_origin: 432.5 },
  { code: 'echizen_takefu', name_ja: '越前たけふ', corridor: 'hokuriku', km_from_origin: 451.9 },
  { code: 'tsuruga', name_ja: '敦賀', corridor: 'hokuriku', km_from_origin: 470.6 },

  { code: 'fukushima_yamagata', name_ja: '福島', corridor: 'yamagata', km_from_origin: 0 },
  { code: 'yonezawa', name_ja: '米沢', corridor: 'yamagata', km_from_origin: 40.1 },
  { code: 'takahata', name_ja: '高畠', corridor: 'yamagata', km_from_origin: 49.9 },
  { code: 'akayu', name_ja: '赤湯', corridor: 'yamagata', km_from_origin: 56.1 },
  { code: 'kaminoyama_onsen', name_ja: 'かみのやま温泉', corridor: 'yamagata', km_from_origin: 75.0 },
  { code: 'yamagata', name_ja: '山形', corridor: 'yamagata', km_from_origin: 87.1 },
  { code: 'tendo', name_ja: '天童', corridor: 'yamagata', km_from_origin: 100.4 },
  { code: 'sakurambo_higashine', name_ja: 'さくらんぼ東根', corridor: 'yamagata', km_from_origin: 106.4 },
  { code: 'murayama', name_ja: '村山', corridor: 'yamagata', km_from_origin: 113.5 },
  { code: 'oishida', name_ja: '大石田', corridor: 'yamagata', km_from_origin: 126.9 },
  { code: 'shinjo', name_ja: '新庄', corridor: 'yamagata', km_from_origin: 148.6 },

  { code: 'morioka_akita', name_ja: '盛岡', corridor: 'akita', km_from_origin: 0 },
  { code: 'shizukuishi', name_ja: '雫石', corridor: 'akita', km_from_origin: 16.0 },
  { code: 'tazawako', name_ja: '田沢湖', corridor: 'akita', km_from_origin: 40.1 },
  { code: 'kakunodate', name_ja: '角館', corridor: 'akita', km_from_origin: 58.8 },
  { code: 'omagari', name_ja: '大曲', corridor: 'akita', km_from_origin: 75.6 },
  { code: 'akita', name_ja: '秋田', corridor: 'akita', km_from_origin: 127.3 },

  { code: 'takeo_onsen', name_ja: '武雄温泉', corridor: 'nishi_kyushu', km_from_origin: 0 },
  { code: 'ureshino_onsen', name_ja: '嬉野温泉', corridor: 'nishi_kyushu', km_from_origin: 9.3 },
  { code: 'shin_omura', name_ja: '新大村', corridor: 'nishi_kyushu', km_from_origin: 32.4 },
  { code: 'isahaya', name_ja: '諫早', corridor: 'nishi_kyushu', km_from_origin: 44.0 },
  { code: 'nagasaki', name_ja: '長崎', corridor: 'nishi_kyushu', km_from_origin: 69.6 }
]

const STATION_INDEX = new Map<string, ShinkansenStation>()
for (const s of SHINKANSEN_STATIONS) STATION_INDEX.set(s.code, s)

export function findShinkansenStation(code: string): ShinkansenStation | undefined {
  return STATION_INDEX.get(code)
}
