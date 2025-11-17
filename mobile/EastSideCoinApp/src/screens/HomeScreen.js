// screens/HomeScreen.js
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useContext,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  ScrollView,
  RefreshControl,
  Animated,
  Easing,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { LineChart } from "react-native-chart-kit";
import { AuthContext } from "../context/AuthProvider";
import { listServices, listBookings, api } from "../utils/api";

// 60617 (South Chicago / East Side / South Deering nearby)
const ZIP_60617_LAT = 41.7239;
const ZIP_60617_LON = -87.5550;

// Weather — Open-Meteo (no key) — request °F + mph
const OPEN_METEO = `https://api.open-meteo.com/v1/forecast?latitude=${ZIP_60617_LAT}&longitude=${ZIP_60617_LON}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago`;

// Air Quality — Open-Meteo (no key) — US AQI & particulates
const OPEN_METEO_AIR = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${ZIP_60617_LAT}&longitude=${ZIP_60617_LON}&hourly=us_aqi,pm2_5,pm10,ozone,carbon_monoxide&timezone=America%2FChicago`;

const BRIDGES = [
  { id: "95th", name: "95th St Bridge (Calumet River)" },
  { id: "100th", name: "100th St Bridge (Calumet River)" },
  { id: "106th", name: "106th St Bridge (Calumet River)" },
  { id: "92nd", name: "92nd St Bridge (Ewing Ave)" },
];

// Civil Rights “Quote of the Day”
const QUOTES = [
  { a: "Martin Luther King Jr.", q: "The time is always right to do what is right." },
  { a: "Malcolm X", q: "The future belongs to those who prepare for it today." },
  {
    a: "Angela Davis",
    q: "I am no longer accepting the things I cannot change. I am changing the things I cannot accept.",
  },
  {
    a: "Fred Hampton",
    q: "We’re going to fight racism not with racism, but we’re going to fight with solidarity.",
  },
  { a: "Fannie Lou Hamer", q: "Nobody’s free until everybody’s free." },
  {
    a: "James Baldwin",
    q: "Not everything that is faced can be changed, but nothing can be changed until it is faced.",
  },
  { a: "Assata Shakur", q: "A wall is just a wall and nothing more at all. It can be broken down." },
  { a: "Audre Lorde", q: "Your silence will not protect you." },
  { a: "Dolores Huerta", q: "Sí, se puede." },
  {
    a: "César Chávez",
    q: "We cannot seek achievement for ourselves and forget about progress and prosperity for our community.",
  },
];

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// How many days of price history to ask backend for
const HISTORY_DAYS = 30;

const priceChartConfig = {
  backgroundColor: "#1b1b1f",
  backgroundGradientFrom: "#1b1b1f",
  backgroundGradientTo: "#1b1b1f",
  decimalPlaces: 4,
  color: (opacity = 1) => `rgba(255, 215, 0, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(200, 200, 210, ${opacity})`,
  propsForDots: {
    r: "3",
  },
  propsForBackgroundLines: {
    strokeDasharray: "3,6",
  },
};

// Daily hash to keep quote stable per day
function pickDailyQuote(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  const idx = h % QUOTES.length;
  return QUOTES[idx];
}

// normalize helper used by dashboard
const normalizeBookings = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.bookings)) return data.bookings;
  return [];
};

const HomeScreen = () => {
  const { user } = useContext(AuthContext);
  const navigation = useNavigation();

  const [greeting, setGreeting] = useState("Welcome");
  const [weather, setWeather] = useState(null);
  const [air, setAir] = useState(null);
  const [news, setNews] = useState([]);
  const [bridgeInfo, setBridgeInfo] = useState([]);
  const [traffic, setTraffic] = useState(null);
  const [escSpots, setEscSpots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Quote of the day
  const [quote, setQuote] = useState(null);

  // Mini-game state
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const coinAnim = useRef(new Animated.Value(0)).current;

  // Dashboard / economy metrics
  const [econ, setEcon] = useState(null);
  const [econLoading, setEconLoading] = useState(false);
  const [econError, setEconError] = useState("");
  const [econExpanded, setEconExpanded] = useState(false); // 🔻 dropdown toggle

  // Animations
  const fadeIn = useRef(new Animated.Value(0)).current;
  const headerFloat = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, {
      toValue: 1,
      duration: 700,
      useNativeDriver: true,
      easing: Easing.out(Easing.cubic),
    }).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(headerFloat, {
          toValue: 1,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
        Animated.timing(headerFloat, {
          toValue: 0,
          duration: 2400,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.quad),
        }),
      ])
    ).start();
  }, [fadeIn, headerFloat]);

  const floatY = headerFloat.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -4],
  });

  // ---------- greeting ----------
  useEffect(() => {
    const d = new Date();
    const h = d.getHours();
    let g = "Welcome";
    if (h < 5) g = "Good night";
    else if (h < 12) g = "Good morning";
    else if (h < 17) g = "Good afternoon";
    else g = "Good evening";
    setGreeting(g);
  }, []);

  // ---------- quote of the day ----------
  const loadQuote = useCallback(async () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const cached = await AsyncStorage.getItem("home_quote_cache");
    if (cached) {
      const stored = JSON.parse(cached);
      if (stored?.date === todayKey) {
        setQuote(stored.quote);
        return;
      }
    }
    const q = pickDailyQuote(todayKey);
    setQuote(q);
    await AsyncStorage.setItem("home_quote_cache", JSON.stringify({ date: todayKey, quote: q }));
  }, []);

  // ---------- weather ----------
  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(OPEN_METEO, { headers: { "Cache-Control": "no-cache" } });
      const json = await res.json();
      setWeather({
        temp: Math.round(json?.current?.temperature_2m),
        feels: Math.round(json?.current?.apparent_temperature),
        wind: Math.round(json?.current?.wind_speed_10m),
        code: json?.current?.weather_code,
        hi: Math.round(json?.daily?.temperature_2m_max?.[0]),
        lo: Math.round(json?.daily?.temperature_2m_min?.[0]),
        precip: json?.daily?.precipitation_probability_max?.[0],
      });
    } catch (e) {
      console.warn("Weather error:", e?.message || e);
    }
  }, []);

  // ---------- air quality ----------
  const loadAir = useCallback(async () => {
    try {
      const res = await fetch(OPEN_METEO_AIR, { headers: { "Cache-Control": "no-cache" } });
      const json = await res.json();
      const hours = json?.hourly?.time || [];
      const i = hours.length ? hours.length - 1 : -1;
      if (i >= 0) {
        const aqi = json?.hourly?.us_aqi?.[i];
        const pm25 = json?.hourly?.pm2_5?.[i];
        const pm10 = json?.hourly?.pm10?.[i];
        setAir({ aqi, pm25, pm10 });
        await AsyncStorage.setItem(
          "home_air_cache",
          JSON.stringify({ aqi, pm25, pm10, t: Date.now() })
        );
      } else {
        setAir(null);
      }
    } catch (e) {
      console.warn("Air quality error:", e?.message || e);
      const cached = await AsyncStorage.getItem("home_air_cache");
      if (cached) setAir(JSON.parse(cached));
    }
  }, []);

  // ---------- news ----------
  const loadNews = useCallback(async () => {
    try {
      const FEED_URLS = [
        "https://api.rss2json.com/v1/api.json?rss_url=https://abc7chicago.com/feed",
        "https://api.rss2json.com/v1/api.json?rss_url=https://wgntv.com/feed/",
        "https://api.rss2json.com/v1/api.json?rss_url=https://southsideweekly.com/feed",
        "https://api.rss2json.com/v1/api.json?rss_url=https://blockclubchicago.org/feed",
        "https://api.rss2json.com/v1/api.json?rss_url=https://feeds.wttw.com/chicagotonight",
      ];

      const results = await Promise.allSettled(
        FEED_URLS.map((u) => fetch(u).then((r) => r.json()))
      );

      const merged = results
        .filter((r) => r.status === "fulfilled" && r.value?.items)
        .flatMap((r) =>
          r.value.items.map((it) => ({
            source: r.value.feed?.title || "Chicago News",
            title: it.title,
            link: it.link,
            pubDate: it.pubDate,
          }))
        );

      const seen = new Set();
      const deduped = merged.filter((n) => {
        if (seen.has(n.title)) return false;
        seen.add(n.title);
        return true;
      });

      deduped.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

      setNews(deduped.slice(0, 20));
      await AsyncStorage.setItem("home_news_cache", JSON.stringify(deduped.slice(0, 40)));
    } catch (e) {
      console.warn("News load error:", e);
      const cached = await AsyncStorage.getItem("home_news_cache");
      if (cached) setNews(JSON.parse(cached).slice(0, 20));
    }
  }, []);

  // ---------- bridge lifts (beta placeholder) ----------
  const loadBridgeInfo = useCallback(async () => {
    try {
      const mock = BRIDGES.map((b, idx) => ({
        id: b.id,
        name: b.name,
        status: idx % 3 === 0 ? "Lifting soon" : idx % 3 === 1 ? "Closed" : "Open",
        eta: idx % 3 === 0 ? "≈ 12 min" : null,
        lastSeenVessel: idx % 2 === 0 ? "Bulk Carrier (downbound)" : "Tug + Barge (upbound)",
      }));
      setBridgeInfo(mock);
    } catch (e) {
      console.warn("Bridge info error:", e?.message || e);
      setBridgeInfo([]);
    }
  }, []);

  // ---------- traffic (beta placeholder) ----------
  const loadTraffic = useCallback(async () => {
    try {
      setTraffic({
        skyway: "Light",
        i90_94: "Moderate",
        i55: "Heavy",
        lakeshore: "Moderate",
      });
    } catch (e) {
      console.warn("Traffic error:", e?.message || e);
      setTraffic(null);
    }
  }, []);

  // ---------- ESC-accepting spots (Food) ----------
  const loadEscSpots = useCallback(async () => {
    try {
      // Filters to Food — adjust category labels as your backend uses them
      const data = await listServices({ category: "Food", limit: 12 });
      const list = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
      // pick the first 6; if later you add accepts_esc flag, filter by it here
      setEscSpots(list.slice(0, 6));
      await AsyncStorage.setItem("home_esc_spots_cache", JSON.stringify(list.slice(0, 12)));
    } catch (e) {
      console.warn("ESC spots error:", e?.message || e);
      const cached = await AsyncStorage.getItem("home_esc_spots_cache");
      if (cached) setEscSpots(JSON.parse(cached).slice(0, 6));
    }
  }, []);

  // ---------- mini-game: load streak/score ----------
  const loadGame = useCallback(async () => {
    const raw = await AsyncStorage.getItem("home_coin_game");
    if (raw) {
      const { score: s = 0, streak: st = 0, lastDate = "" } = JSON.parse(raw) || {};
      const today = new Date().toISOString().slice(0, 10);
      const newStreak = lastDate === today ? st : lastDate ? st + 1 : 1;
      setScore(s);
      setStreak(newStreak);
      await AsyncStorage.setItem(
        "home_coin_game",
        JSON.stringify({ score: s, streak: newStreak, lastDate: today })
      );
    } else {
      const today = new Date().toISOString().slice(0, 10);
      setScore(0);
      setStreak(1);
      await AsyncStorage.setItem(
        "home_coin_game",
        JSON.stringify({ score: 0, streak: 1, lastDate: today })
      );
    }
  }, []);

  const saveGame = useCallback(async (s, st) => {
    const today = new Date().toISOString().slice(0, 10);
    await AsyncStorage.setItem(
      "home_coin_game",
      JSON.stringify({ score: s, streak: st, lastDate: today })
    );
  }, []);

  const tapCoin = useCallback(() => {
    const next = score + 1;
    setScore(next);
    saveGame(next, streak);
    // little bounce
    coinAnim.setValue(0);
    Animated.timing(coinAnim, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [score, streak, saveGame, coinAnim]);

  const coinScale = coinAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.16] });
  const coinUp = coinAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });

  // ---------- ECONOMY DASHBOARD ----------
  const loadEconomy = useCallback(async () => {
    setEconLoading(true);
    setEconError("");
    try {
      const now = new Date();
      const fromDate = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
      const fromISO = fromDate.toISOString().slice(0, 10) + "T00:00:00";
      const toISO = now.toISOString();

      const [walletPayload, providerRes, clientRes, servicesRes, escStatsPayload] =
        await Promise.all([
          api.get("/wallet/balance/").catch(() => ({})),
          listBookings({
            role: "provider",
            status: "completed",
            from: fromISO,
            to: toISO,
            limit: 200,
            page: 1,
          }).catch(() => []),
          listBookings({
            role: "client",
            status: "completed",
            from: fromISO,
            to: toISO,
            limit: 200,
            page: 1,
          }).catch(() => []),
          listServices({ limit: 500 }).catch(() => []),
          api.get(`/esc/stats/?days=${HISTORY_DAYS}`).catch(() => null), // ✅ backend-driven ESC stats & price history
        ]);

      const walletBalance = Number(walletPayload?.balance ?? 0);

      const providerBookings = normalizeBookings(providerRes);
      const clientBookings = normalizeBookings(clientRes);

      const earnedAsProvider = providerBookings.reduce(
        (sum, b) => sum + Number(b.price_snapshot ?? 0),
        0
      );
      const spentAsClient = clientBookings.reduce(
        (sum, b) => sum + Number(b.price_snapshot ?? 0),
        0
      );

      const allCompleted = [...providerBookings, ...clientBookings];
      const totalVolume = allCompleted.reduce(
        (sum, b) => sum + Number(b.price_snapshot ?? 0),
        0
      );
      const avgBookingPrice =
        allCompleted.length > 0 ? totalVolume / allCompleted.length : 0;

      const svcList = Array.isArray(servicesRes?.results)
        ? servicesRes.results
        : Array.isArray(servicesRes)
        ? servicesRes
        : [];
      const totalServices = svcList.length;
      const foodServices = svcList.filter((s) =>
        (s.category || "").toLowerCase().includes("food")
      ).length;

      // ---- token / on-chain style stats (from /esc/stats/) ----
      const stats =
        escStatsPayload && Object.keys(escStatsPayload).length ? escStatsPayload : {};

      const totalSupply = Number(
        stats.total_supply ??
          stats.totalSupply ??
          stats.total_supply_esc ??
          0
      );

      const circulatingSupply = Number(
        stats.circulating_supply ??
          stats.circulating ??
          stats.circulatingSupply ??
          stats.circulating_supply_esc ??
          stats.circulating_slice_esc ??
          0
      );

      const burnedSupply = Number(
        stats.burned_supply ??
          stats.burned ??
          stats.burned_esc ??
          0
      );

      const holders = Number(
        stats.holders ??
          stats.unique_holders ??
          stats.holder_count ??
          0
      );

      const priceUSD = Number(
        stats.price_usd ??
          stats.priceUsd ??
          stats.price ??
          stats.price_final_usd ??
          0
      );

      const priceUSDC =
        Number(
          stats.price_usdc ??
            stats.priceUsdc ??
            stats.pair_price_usdc ??
            0
        ) || priceUSD;

      const marketCapUSD = Number(
        stats.market_cap_usd ??
          stats.marketCapUsd ??
          stats.market_cap ??
          stats.marketCap ??
          (priceUSD && circulatingSupply ? priceUSD * circulatingSupply : 0)
      );

      const tx24h = Number(
        stats.tx_24h ??
          stats.transactions_24h ??
          stats.tx_count ??
          0
      );

      const volume24hESC = Number(
        stats.volume_24h_esc ??
          stats.volume24hEsc ??
          stats.volume_esc ??
          0
      );

      const volume24hUSD = Number(
        stats.volume_24h_usd ??
          stats.volume24hUsd ??
          (priceUSD && volume24hESC ? priceUSD * volume24hESC : 0)
      );

      // LP values – from stats if available, otherwise compute simple USDC * 5x as placeholder
      const lpEsc = Number(
        stats.lp_esc ??
          stats.lpEsc ??
          0
      );
      const lpUsdc = Number(
        stats.lp_usdc ??
          stats.lpUsdc ??
          0
      );
      const lpLockedUSD = Number(
        stats.lp_locked_usd ??
          stats.lpLockedUsd ??
          (lpUsdc || priceUSD ? lpUsdc : 0)
      );
      const lpTokens = Number(
        stats.lp_tokens ??
          stats.lpTokens ??
          0
      );

      const starterAccounts =
        Number(stats.starter_accounts ?? stats.starterAccounts ?? 0) || 0;
      const starterPerAccount =
        Number(stats.starter_per_account ?? stats.starterPerAccount ?? 0) || 0;
      const starterAllocationESC =
        Number(stats.starter_allocation_esc ?? stats.starterAllocationEsc ?? 0) || 0;

      const founderReserveESC = Number(
        stats.founder_reserve_esc ??
          stats.founderReserveEsc ??
          0
      );
      const treasuryReserveESC = Number(
        stats.treasury_reserve_esc ??
          stats.treasuryReserveEsc ??
          0
      );
      const undistributedSupply = Number(
        stats.undistributed_supply ??
          stats.undistributedSupply ??
          0
      );

      const mintedESC = Number(
        stats.minted_esc ??
          stats.minted ??
          0
      );

      const rawHistory = stats.price_history ?? stats.priceHistory ?? [];
      const priceHistory = Array.isArray(rawHistory)
        ? rawHistory
            .map((v) => Number(v))
            .filter((v) => typeof v === "number" && !Number.isNaN(v))
        : [];

      const priceLabels =
        Array.isArray(stats.price_labels ?? stats.priceLabels) &&
        (stats.price_labels ?? stats.priceLabels).length === priceHistory.length
          ? stats.price_labels ?? stats.priceLabels
          : null;

      const historyDays = Number(stats.history_days ?? stats.historyDays ?? HISTORY_DAYS);

      const founderReserveUSD = priceUSD * founderReserveESC;
      const treasuryReserveUSD = priceUSD * treasuryReserveESC;
      const mintedUSD = priceUSD * mintedESC;

      const circulatingPct =
        totalSupply > 0 ? (circulatingSupply / totalSupply) * 100 : null;

      setEcon({
        // on-chain style token stats
        totalSupply,
        circulatingSupply,
        burnedSupply,
        holders,
        priceUSD,
        priceUSDC,
        marketCapUSD,
        tx24h,
        volume24hESC,
        volume24hUSD,
        lpLockedUSD,
        lpTokens,
        circulatingPct,
        starterAccounts,
        starterPerAccount,
        starterAllocationESC,
        founderReserveESC,
        founderReserveUSD,
        treasuryReserveESC,
        treasuryReserveUSD,
        undistributedSupply,
        mintedESC,
        mintedUSD,
        lpEsc,
        lpUsdc,
        priceHistory, // ✅ backend-driven price history
        priceLabels, // ✅ optional backend labels for the chart
        historyDays, // ✅ window of days for the chart

        // wallet + marketplace flow (last N days)
        walletBalance,
        completedAsProvider: providerBookings.length,
        completedAsClient: clientBookings.length,
        earnedAsProvider,
        spentAsClient,
        totalVolume,
        avgBookingPrice,
        totalServices,
        foodServices,
      });
    } catch (e) {
      console.warn("Economy load error:", e?.message || e);
      setEconError("Couldn’t load ESC metrics right now.");
    } finally {
      setEconLoading(false);
    }
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([
        loadQuote(),
        loadWeather(),
        loadAir(),
        loadNews(),
        loadBridgeInfo(),
        loadTraffic(),
        loadEscSpots(),
        loadGame(),
        loadEconomy(), // ✅ include econ on boot
      ]);
      setLoading(false);
    })();
  }, [
    loadQuote,
    loadWeather,
    loadAir,
    loadNews,
    loadBridgeInfo,
    loadTraffic,
    loadEscSpots,
    loadGame,
    loadEconomy,
  ]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      loadQuote(),
      loadWeather(),
      loadAir(),
      loadNews(),
      loadBridgeInfo(),
      loadTraffic(),
      loadEscSpots(),
      loadEconomy(), // ✅ refresh econ as well
    ]);
    setRefreshing(false);
  }, [
    loadQuote,
    loadWeather,
    loadAir,
    loadNews,
    loadBridgeInfo,
    loadTraffic,
    loadEscSpots,
    loadEconomy,
  ]);

  // ---------- helpers ----------
  const weatherLabel = useMemo(() => {
    if (!weather) return "—";
    const wc = weather.code;
    if ([0].includes(wc)) return "Clear";
    if ([1, 2, 3].includes(wc)) return "Partly cloudy";
    if ([45, 48].includes(wc)) return "Fog";
    if ([51, 53, 55, 56, 57].includes(wc)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(wc)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(wc)) return "Snow";
    if ([95, 96, 99].includes(wc)) return "Thunderstorm";
    return "Weather";
  }, [weather]);

  const aqiBadge = useMemo(() => {
    const a = air?.aqi ?? null;
    if (a == null) return { label: "—", color: "#666" };
    if (a <= 50) return { label: "Good", color: "#2f8f46" };
    if (a <= 100) return { label: "Moderate", color: "#d1a000" };
    if (a <= 150) return { label: "Unhealthy (SG)", color: "#d17b00" };
    if (a <= 200) return { label: "Unhealthy", color: "#c93636" };
    if (a <= 300) return { label: "Very Unhealthy", color: "#7b3dc9" };
    return { label: "Hazardous", color: "#7d0022" };
  }, [air]);

  const tokenDistribution = useMemo(() => {
    if (!econ || !econ.totalSupply) return null;
    const total = econ.totalSupply || 1;
    const circ = Math.max(0, econ.circulatingSupply || 0);
    const burned = Math.max(0, econ.burnedSupply || 0);
    const reserves = Math.max(
      0,
      (econ.founderReserveESC || 0) +
        (econ.treasuryReserveESC || 0) +
        (econ.undistributedSupply || 0)
    );
    const circPct = (circ / total) * 100;
    const burnedPct = (burned / total) * 100;
    const reservesPct = (reserves / total) * 100;
    return { circPct, burnedPct, reservesPct, circ, burned, reserves };
  }, [econ]);

  // Price chart labels: prefer backend labels; otherwise auto-generate based on window
  const priceChartLabels = useMemo(() => {
    if (!econ || !Array.isArray(econ.priceHistory) || econ.priceHistory.length < 2) {
      return null;
    }
    const len = econ.priceHistory.length;

    if (econ.priceLabels && Array.isArray(econ.priceLabels) && econ.priceLabels.length === len) {
      return econ.priceLabels;
    }

    const windowDays = econ.historyDays || HISTORY_DAYS;

    // If backend window matches history length, label as -Xd ... Today
    if (windowDays && windowDays === len) {
      return Array.from({ length: len }, (_, idx) => {
        if (idx === len - 1) return "Now";
        const daysAgo = len - 1 - idx;
        return `-${daysAgo}d`;
      });
    }

    // Fallback generic labels
    return Array.from({ length: len }, (_, idx) =>
      idx === len - 1 ? "Now" : `D-${len - 1 - idx}`
    );
  }, [econ]);

  const NewsCard = ({ item, idx }) => (
    <TouchableOpacity
      key={`${idx}-${item.title}`}
      style={styles.newsCard}
      onPress={() => Linking.openURL(item.link)}
    >
      <Text style={styles.newsTitle} numberOfLines={3}>
        {item.title}
      </Text>
      <Text style={styles.newsMeta} numberOfLines={1}>
        {item.source}
      </Text>
    </TouchableOpacity>
  );

  const Spot = ({ s }) => (
    <View key={s.id} style={styles.spotRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.spotTitle} numberOfLines={1}>
          {s.title || s.name || "Local spot"}
        </Text>
        {!!s.description && (
          <Text style={styles.spotMeta} numberOfLines={2}>
            {s.description}
          </Text>
        )}
        {!!s.price && <Text style={styles.spotPrice}>~ {s.price} ESC</Text>}
      </View>
      <View style={styles.escPill}>
        <Text style={styles.escPillText}>ESC</Text>
      </View>
    </View>
  );

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const fmtEsc = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { maximumFractionDigits: 4 })
      : "0.0000";

  const fmtUSD = (n) =>
    typeof n === "number"
      ? "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 })
      : "$0.0000";

  const fmtInt = (n) =>
    typeof n === "number" ? n.toLocaleString(undefined) : "0";

  const fmtPct = (n) =>
    typeof n === "number"
      ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%"
      : "—";

  return (
    <SafeAreaView style={styles.safe}>
      {/* background accents */}
      <View style={styles.bg}>
        <View style={[styles.accent, styles.accentTop]} />
        <View style={[styles.accent, styles.accentBottom]} />
      </View>

      <Animated.View style={[styles.screen, { opacity: fadeIn }]}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#FFD700"
            />
          }
        >
          {/* Header / Greeting */}
          <Animated.View style={[styles.headerWrap, { transform: [{ translateY: floatY }] }]}>
            <Text style={styles.greeting}>
              {greeting}
              {user?.first_name ? `, ${user.first_name}` : ""}
            </Text>
            <Text style={styles.title}>EastSide Coin</Text>
            <Text style={styles.subtleDate}>{today} • America/Chicago</Text>
          </Animated.View>

          {/* ESC ECONOMY DASHBOARD (dropdown) */}
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.cardHeaderRow}
              onPress={() => setEconExpanded((prev) => !prev)}
              activeOpacity={0.8}
            >
              <View style={styles.headerLeft}>
                <Text style={styles.cardHeader}>Neighborhood Economy • Dashboard</Text>
                <Text style={styles.caret}>{econExpanded ? "▾" : "▸"}</Text>
              </View>
              {econLoading ? <ActivityIndicator size="small" color="#FFD700" /> : null}
            </TouchableOpacity>

            <Text style={styles.econSubtitle}>
              ESC on-chain stats + last {econ?.historyDays || HISTORY_DAYS} days of bookings
            </Text>
            {econError ? <Text style={styles.errorText}>{econError}</Text> : null}

            {econ ? (
              <>
                {/* Always-on mini strip so people see key stats even when collapsed */}
                <View style={styles.collapsedRow}>
                  <View style={styles.collapsedMetric}>
                    <Text style={styles.metricLabel}>Price</Text>
                    <Text style={styles.metricValueSm}>
                      {econ.priceUSD ? fmtUSD(econ.priceUSD) : "—"}
                    </Text>
                  </View>
                  <View style={styles.collapsedMetric}>
                    <Text style={styles.metricLabel}>Accounts</Text>
                    <Text style={styles.metricValueSm}>{fmtInt(econ.holders)}</Text>
                  </View>
                  <View style={styles.collapsedMetric}>
                    <Text style={styles.metricLabel}>Mkt cap</Text>
                    <Text style={styles.metricValueSm}>
                      {econ.marketCapUSD ? fmtUSD(econ.marketCapUSD) : "—"}
                    </Text>
                  </View>
                </View>

                {econExpanded && (
                  <>
                    {/* On-chain style metrics */}
                    <View style={styles.metricsGrid}>
                      <View style={styles.metricBoxWide}>
                        <Text style={styles.metricLabel}>Price</Text>
                        <Text style={styles.metricValue}>
                          {fmtUSD(econ.priceUSD)}{" "}
                          <Text style={styles.metricTinyInline}>per ESC</Text>
                        </Text>
                        <Text style={styles.metricTiny}>
                          Pair: ESC / USDC ~ {fmtUSD(econ.priceUSDC)}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Circulating supply</Text>
                        <Text style={styles.metricValue}>
                          {fmtInt(econ.circulatingSupply)}
                        </Text>
                        <Text style={styles.metricTiny}>
                          {econ.circulatingPct != null
                            ? fmtPct(econ.circulatingPct) + " of total"
                            : "of total supply"}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Total / Burned</Text>
                        <Text style={styles.metricValue}>{fmtInt(econ.totalSupply)}</Text>
                        <Text style={styles.metricTiny}>
                          Burned: {fmtInt(econ.burnedSupply)}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Protocol minted</Text>
                        <Text style={styles.metricValue}>{fmtInt(econ.mintedESC)}</Text>
                        <Text style={styles.metricTiny}>
                          ≈ {fmtUSD(econ.mintedUSD || 0)} at current price
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Market cap</Text>
                        <Text style={styles.metricValue}>{fmtUSD(econ.marketCapUSD)}</Text>
                        <Text style={styles.metricTiny}>
                          {fmtInt(econ.holders)} holder
                          {econ.holders === 1 ? "" : "s"}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>24h activity</Text>
                        <Text style={styles.metricValue}>{fmtInt(econ.tx24h)}</Text>
                        <Text style={styles.metricTiny}>
                          {fmtEsc(econ.volume24hESC)} ESC / {fmtUSD(econ.volume24hUSD)}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>LP locked</Text>
                        <Text style={styles.metricValue}>{fmtUSD(econ.lpLockedUSD)}</Text>
                        <Text style={styles.metricTiny}>
                          LP tokens: {fmtInt(econ.lpTokens)}
                        </Text>
                      </View>
                    </View>

                    {/* Reserve callout for founder reserve (dynamic, not hard-coded) */}
                    {econ.founderReserveESC ? (
                      <View style={styles.reserveRow}>
                        <Text style={styles.reserveLabel}>
                          Founder reserve (off-market stabilizer)
                        </Text>
                        <Text style={styles.reserveValue}>
                          {fmtEsc(econ.founderReserveESC)} ESC ·{" "}
                          {fmtUSD(econ.founderReserveUSD)}
                        </Text>
                        <Text style={styles.metricTiny}>
                          Not counted in market cap — can be dripped in later to stabilize the
                          neighborhood economy.
                        </Text>
                      </View>
                    ) : null}

                    {/* Price history chart + token distribution */}
                    {(econ.priceHistory && econ.priceHistory.length > 1) || tokenDistribution ? (
                      <View style={styles.chartSection}>
                        {econ.priceHistory && econ.priceHistory.length > 1 && (
                          <>
                            <Text style={styles.chartTitle}>
                              ESC price (last {econ.historyDays || HISTORY_DAYS} days)
                            </Text>
                            <Text style={styles.chartSubtitle}>
                              Purely from /esc/stats/ — sim + real trades driving up price over this window.
                            </Text>
                            <LineChart
                              data={{
                                labels: priceChartLabels || [],
                                datasets: [{ data: econ.priceHistory }],
                              }}
                              width={SCREEN_WIDTH - 64}
                              height={160}
                              chartConfig={priceChartConfig}
                              withInnerLines={false}
                              withOuterLines={false}
                              bezier
                              style={styles.chartKit}
                            />
                          </>
                        )}

                        {tokenDistribution && (
                          <>
                            <Text style={[styles.chartTitle, { marginTop: 10 }]}>
                              Token distribution
                            </Text>
                            <View style={styles.chartBar}>
                              <View
                                style={[
                                  styles.chartSegmentCirculating,
                                  { flex: Math.max(tokenDistribution.circPct, 1) },
                                ]}
                              />
                              <View
                                style={[
                                  styles.chartSegmentBurned,
                                  { flex: Math.max(tokenDistribution.burnedPct, 0.5) },
                                ]}
                              />
                              <View
                                style={[
                                  styles.chartSegmentTreasury,
                                  { flex: Math.max(tokenDistribution.reservesPct, 0.5) },
                                ]}
                              />
                            </View>
                            <View style={styles.chartLegendRow}>
                              <View style={styles.chartLegendItem}>
                                <View
                                  style={[styles.chartLegendDot, styles.dotCirculating]}
                                />
                                <Text style={styles.chartLegendText}>
                                  Circulating · {fmtPct(tokenDistribution.circPct)} (
                                  {fmtInt(tokenDistribution.circ)})
                                </Text>
                              </View>
                              <View style={styles.chartLegendItem}>
                                <View style={[styles.chartLegendDot, styles.dotBurned]} />
                                <Text style={styles.chartLegendText}>
                                  Burned · {fmtPct(tokenDistribution.burnedPct)} (
                                  {fmtInt(tokenDistribution.burned)})
                                </Text>
                              </View>
                              <View style={styles.chartLegendItem}>
                                <View
                                  style={[styles.chartLegendDot, styles.dotTreasury]}
                                />
                                <Text style={styles.chartLegendText}>
                                  Reserves (founder + treasury + undistributed) ·{" "}
                                  {fmtPct(tokenDistribution.reservesPct)}
                                </Text>
                              </View>
                            </View>
                          </>
                        )}
                      </View>
                    ) : null}

                    <View style={styles.sectionDivider} />

                    {/* Local booking / marketplace metrics */}
                    <Text style={styles.subSectionTitle}>
                      Neighborhood bookings · last {econ.historyDays || HISTORY_DAYS} days
                    </Text>
                    <View style={styles.metricsGrid}>
                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Wallet balance</Text>
                        <Text style={styles.metricValue}>
                          {fmtEsc(econ.walletBalance)} ESC
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Earned as provider</Text>
                        <Text style={styles.metricValue}>
                          {fmtEsc(econ.earnedAsProvider)} ESC
                        </Text>
                        <Text style={styles.metricTiny}>
                          {econ.completedAsProvider} completed booking
                          {econ.completedAsProvider === 1 ? "" : "s"}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Spent as client</Text>
                        <Text style={styles.metricValue}>
                          {fmtEsc(econ.spentAsClient)} ESC
                        </Text>
                        <Text style={styles.metricTiny}>
                          {econ.completedAsClient} completed booking
                          {econ.completedAsClient === 1 ? "" : "s"}
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Total ESC flow</Text>
                        <Text style={styles.metricValue}>
                          {fmtEsc(econ.totalVolume)} ESC
                        </Text>
                        <Text style={styles.metricTiny}>
                          Avg. {fmtEsc(econ.avgBookingPrice)} ESC / booking
                        </Text>
                      </View>

                      <View style={styles.metricBox}>
                        <Text style={styles.metricLabel}>Services live</Text>
                        <Text style={styles.metricValue}>{econ.totalServices}</Text>
                        <Text style={styles.metricTiny}>
                          {econ.foodServices} Food / Restaurants
                        </Text>
                      </View>
                    </View>

                    <View style={styles.metricFooterRow}>
                      <TouchableOpacity
                        style={styles.metricBtn}
                        onPress={() => navigation.navigate("Wallet")}
                      >
                        <Text style={styles.metricBtnText}>View Wallet</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.metricBtnAlt}
                        onPress={() => navigation.navigate("Bookings")}
                      >
                        <Text style={styles.metricBtnAltText}>View Bookings</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.metricNote}>
                      On-chain numbers and price history come from the ESC stats endpoint.
                      Neighborhood stats come from completed bookings and wallet activity
                      over this same window.
                    </Text>
                  </>
                )}
              </>
            ) : !econLoading ? (
              <Text style={styles.empty}>
                No booking or token data yet. Seed ESC stats and complete a service to see
                activity.
              </Text>
            ) : null}
          </View>

          {/* Quote of the Day */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>Quote of the Day</Text>
            </View>
            {quote ? (
              <View>
                <Text style={styles.quoteText}>“{quote.q}”</Text>
                <Text style={styles.quoteAuthor}>— {quote.a}</Text>
              </View>
            ) : (
              <ActivityIndicator />
            )}
          </View>

          {/* Weather + Air */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>60617 Weather & Air</Text>
              <TouchableOpacity style={styles.smallBtn} onPress={onRefresh}>
                <Text style={styles.smallBtnText}>Refresh</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.weatherRow}>
              {weather ? (
                <View style={{ flex: 1 }}>
                  <Text style={styles.weatherTemp}>{weather.temp}°</Text>
                  <Text style={styles.weatherSub}>
                    {weatherLabel} • Feels {weather.feels}°
                  </Text>
                  <Text style={styles.weatherSub}>
                    H {weather.hi}°  L {weather.lo}°  ·  Wind {weather.wind} mph
                  </Text>
                  {typeof weather.precip === "number" && (
                    <Text style={styles.weatherSub}>Rain chance {weather.precip}%</Text>
                  )}
                </View>
              ) : (
                <ActivityIndicator />
              )}

              <View style={styles.aqiBox}>
                <Text style={styles.aqiTitle}>Air</Text>
                {air ? (
                  <>
                    <View style={[styles.aqiBadge, { borderColor: aqiBadge.color }]}>
                      <Text style={[styles.aqiBadgeText, { color: aqiBadge.color }]}>
                        {aqiBadge.label}
                      </Text>
                    </View>
                    <Text style={styles.aqiMeta}>
                      US AQI {Math.round(air.aqi ?? 0)}
                    </Text>
                    <Text style={styles.aqiMeta}>
                      PM2.5 {Math.round(air.pm25 ?? 0)} µg/m³
                    </Text>
                  </>
                ) : (
                  <Text style={styles.aqiMeta}>—</Text>
                )}
              </View>
            </View>
          </View>

          {/* Chicago Headlines (horizontal) */}
          <View style={styles.card}>
            <Text style={styles.cardHeader}>Chicago Headlines</Text>
            {loading && news.length === 0 ? (
              <ActivityIndicator style={{ marginTop: 12 }} />
            ) : news.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginTop: 8 }}
              >
                {news.map((item, idx) => (
                  <NewsCard item={item} idx={idx} key={`${idx}-${item.title}`} />
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.empty}>No headlines right now. Pull to refresh.</Text>
            )}
          </View>

          {/* Accepts ESC — local Food spots */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>Eat Local • Accepts ESC</Text>
              <Text style={styles.tag}>Food</Text>
            </View>
            {escSpots.length ? (
              escSpots.map((s) => <Spot key={s.id} s={s} />)
            ) : (
              <Text style={styles.empty}>
                No listings yet. Add your spot in Marketplace → Create Service.
              </Text>
            )}
          </View>

          {/* Bridge Lift Watch (beta) */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>Bridge Lift Watch (Beta)</Text>
              <Text style={styles.tag}>Experimental</Text>
            </View>
            {bridgeInfo.length === 0 ? (
              <Text style={styles.empty}>No data yet.</Text>
            ) : (
              bridgeInfo.map((b) => (
                <View key={b.id} style={styles.bridgeRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bridgeName}>{b.name}</Text>
                    <Text style={styles.bridgeMeta}>
                      {b.status}
                      {b.eta ? ` • ETA ${b.eta}` : ""}
                    </Text>
                    {b.lastSeenVessel && (
                      <Text style={styles.bridgeVessel}>
                        Last seen vessel: {b.lastSeenVessel}
                      </Text>
                    )}
                  </View>
                  <View
                    style={[
                      styles.statusPill,
                      b.status === "Open"
                        ? styles.ok
                        : b.status === "Lifting soon"
                        ? styles.warn
                        : styles.idle,
                    ]}
                  >
                    <Text style={styles.pillText}>
                      {b.status === "Open"
                        ? "OPEN"
                        : b.status === "Lifting soon"
                        ? "SOON"
                        : "CLOSED"}
                    </Text>
                  </View>
                </View>
              ))
            )}
            <Text style={styles.note}>
              We’re prototyping AIS-based predictions for East Side bridges (95th, 100th,
              106th, 92nd/Ewing).
            </Text>
          </View>

          {/* Traffic Snapshot (beta) */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>Traffic Snapshot (Beta)</Text>
              <Text style={styles.tag}>Experimental</Text>
            </View>
            {traffic ? (
              <View>
                <Text style={styles.trafficLine}>
                  Skyway: <Text style={styles.bold}>{traffic.skyway}</Text>
                </Text>
                <Text style={styles.trafficLine}>
                  I-90/94: <Text style={styles.bold}>{traffic.i90_94}</Text>
                </Text>
                <Text style={styles.trafficLine}>
                  I-55: <Text style={styles.bold}>{traffic.i55}</Text>
                </Text>
                <Text style={styles.trafficLine}>
                  DuSable LSD: <Text style={styles.bold}>{traffic.lakeshore}</Text>
                </Text>
              </View>
            ) : (
              <Text style={styles.empty}>No snapshot yet.</Text>
            )}
            <Text style={styles.note}>
              Next step: hook this to City of Chicago congestion data or a map traffic API.
            </Text>
          </View>

          {/* Mini Retro Game: Coin Tap */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>Mini Game • Coin Tap</Text>
              <Text style={styles.tag}>Just for fun</Text>
            </View>
            <Text style={styles.gameMeta}>
              Daily streak: {streak} day{streak === 1 ? "" : "s"}
            </Text>
            <Text style={styles.gameMeta}>Score: {score}</Text>
            <Animated.View style={{ transform: [{ scale: coinScale }, { translateY: coinUp }] }}>
              <TouchableOpacity onPress={tapCoin} style={styles.coinBtn} activeOpacity={0.8}>
                <Text style={styles.coinBtnText}>🪙 Tap</Text>
              </TouchableOpacity>
            </Animated.View>
            <Text style={styles.note}>
              Tap to collect coins. It’s silly on purpose. 😄
            </Text>
          </View>

          {/* Footer */}
          <Text style={styles.footer}>America/Chicago</Text>
        </ScrollView>
      </Animated.View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#101012" },

  bg: { ...StyleSheet.absoluteFillObject, zIndex: -1 },
  accent: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    opacity: 0.14,
    transform: [{ rotate: "15deg" }],
  },
  accentTop: { top: -90, right: -70, backgroundColor: "#FFD700" },
  accentBottom: { bottom: -110, left: -80, backgroundColor: "#FF4500" },

  screen: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 28 },

  headerWrap: { marginTop: 8, marginBottom: 10, alignItems: "flex-start" },
  greeting: { color: "#BBBBBB", fontSize: 14, marginBottom: 2 },
  title: { fontSize: 26, fontWeight: "800", color: "#FFD700" },
  subtleDate: { marginTop: 4, color: "#9a9aa1", fontSize: 12 },

  card: {
    backgroundColor: "#1b1b1f",
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    borderColor: "#2a2a2e",
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },

  cardHeader: { color: "#EEE", fontWeight: "700", fontSize: 16 },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  caret: {
    color: "#FFD700",
    fontSize: 16,
    marginTop: 1,
  },
  tag: {
    color: "#FFD700",
    fontSize: 12,
    borderColor: "#3a3a3a",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },

  // ECON DASHBOARD
  econSubtitle: { color: "#9a9aa1", fontSize: 12, marginBottom: 6 },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 4,
    marginHorizontal: -4,
  },
  metricBox: {
    width: "50%",
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  metricBoxWide: {
    width: "100%",
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  metricLabel: { color: "#9a9aa1", fontSize: 11, marginBottom: 2 },
  metricValue: { color: "#FFD700", fontSize: 18, fontWeight: "800" },
  metricTiny: { color: "#bfbfc6", fontSize: 11, marginTop: 2 },
  metricTinyInline: { color: "#bfbfc6", fontSize: 12, fontWeight: "400" },
  metricFooterRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  metricBtn: {
    flex: 1,
    backgroundColor: "#FFD700",
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
  },
  metricBtnText: { color: "#101012", fontWeight: "800", fontSize: 14 },
  metricBtnAlt: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#3a3a3a",
    backgroundColor: "#24242a",
  },
  metricBtnAltText: { color: "#EEE", fontWeight: "800", fontSize: 14 },
  metricNote: { color: "#7a7a7a", fontSize: 11, marginTop: 8 },
  errorText: { color: "#ff6b6b", fontSize: 12, marginTop: 4 },
  subSectionTitle: {
    color: "#c7c7ce",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 10,
    marginBottom: 2,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: "#2a2a2e",
    marginTop: 8,
    marginBottom: 4,
    opacity: 0.8,
  },

  collapsedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  collapsedMetric: {
    flex: 1,
    paddingRight: 8,
  },
  metricValueSm: {
    color: "#FFD700",
    fontSize: 14,
    fontWeight: "700",
  },

  reserveRow: {
    marginTop: 8,
  },
  reserveLabel: {
    color: "#c7c7ce",
    fontSize: 12,
    fontWeight: "700",
  },
  reserveValue: {
    color: "#FFD700",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 2,
  },

  // Simple chart styles
  chartSection: {
    marginTop: 10,
  },
  chartTitle: {
    color: "#c7c7ce",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 4,
  },
  chartSubtitle: {
    color: "#9a9aa1",
    fontSize: 11,
    marginBottom: 6,
  },
  chartBar: {
    height: 16,
    borderRadius: 999,
    overflow: "hidden",
    flexDirection: "row",
    backgroundColor: "#202026",
  },
  chartSegmentCirculating: {
    backgroundColor: "#FFD700",
  },
  chartSegmentBurned: {
    backgroundColor: "#FF7A1B",
  },
  chartSegmentTreasury: {
    backgroundColor: "#4B4BF3",
  },
  chartLegendRow: {
    marginTop: 6,
  },
  chartLegendItem: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  chartLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    marginRight: 6,
  },
  dotCirculating: {
    backgroundColor: "#FFD700",
  },
  dotBurned: {
    backgroundColor: "#FF7A1B",
  },
  dotTreasury: {
    backgroundColor: "#4B4BF3",
  },
  chartLegendText: {
    color: "#bfbfc6",
    fontSize: 11,
  },
  chartKit: {
    borderRadius: 12,
  },

  // Quote
  quoteText: { color: "#EEE", fontSize: 16, lineHeight: 22, fontStyle: "italic" },
  quoteAuthor: { color: "#CFCFCF", fontSize: 13, marginTop: 6, textAlign: "right" },

  // Weather + Air
  weatherRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  weatherTemp: { color: "#FFFFFF", fontSize: 44, fontWeight: "800", lineHeight: 46 },
  weatherSub: { color: "#BEBEBE", marginTop: 2, fontSize: 13 },

  aqiBox: {
    width: 150,
    marginLeft: 12,
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: "#2a2a2e",
  },
  aqiTitle: { color: "#EEE", fontWeight: "700", marginBottom: 6 },
  aqiBadge: {
    borderWidth: 1.5,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    alignSelf: "flex-start",
    marginBottom: 6,
  },
  aqiBadgeText: { fontWeight: "800" },
  aqiMeta: { color: "#BEBEBE", fontSize: 12 },

  // Horizontal news cards
  newsCard: {
    width: 220,
    marginRight: 10,
    backgroundColor: "#222329",
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  newsTitle: { color: "#EEE", fontSize: 15, fontWeight: "700", marginBottom: 6 },
  newsMeta: { color: "#8a8a8f", fontSize: 12 },

  // ESC spots
  spotRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomColor: "#2a2a2e",
    borderBottomWidth: 1,
  },
  spotTitle: { color: "#EEE", fontSize: 15, fontWeight: "700" },
  spotMeta: { color: "#BEBEBE", fontSize: 12, marginTop: 2 },
  spotPrice: { color: "#FFD700", fontSize: 12, marginTop: 4, fontWeight: "800" },
  escPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#FFD700",
    marginLeft: 10,
  },
  escPillText: { color: "#FFD700", fontWeight: "800", letterSpacing: 0.5 },

  // Bridges
  bridgeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomColor: "#2a2a2e",
    borderBottomWidth: 1,
  },
  bridgeName: { color: "#EEE", fontSize: 15, fontWeight: "700" },
  bridgeMeta: { color: "#BEBEBE", fontSize: 12, marginTop: 2 },
  bridgeVessel: { color: "#909090", fontSize: 12, marginTop: 2 },

  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  ok: { borderColor: "#2f8f46" },
  warn: { borderColor: "#d1a000" },
  idle: { borderColor: "#555" },
  pillText: { color: "#DDD", fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },

  // Traffic
  trafficLine: { color: "#BEBEBE", fontSize: 13, marginTop: 3 },
  bold: { color: "#EEE", fontWeight: "700" },

  // Mini-game
  gameMeta: { color: "#BEBEBE", fontSize: 12, marginBottom: 6 },
  coinBtn: {
    alignSelf: "center",
    backgroundColor: "#FF7A1B",
    paddingVertical: 12,
    paddingHorizontal: 26,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#FFB067",
    marginTop: 6,
  },
  coinBtnText: { color: "#fff", fontSize: 18, fontWeight: "900", letterSpacing: 0.5 },

  // Common
  smallBtn: {
    backgroundColor: "#2d2d2f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderColor: "#3a3a3f",
    borderWidth: 1,
  },
  smallBtnText: { color: "#FFD700", fontWeight: "700" },

  empty: { color: "#888", textAlign: "left", marginTop: 8 },
  note: { color: "#7a7a7a", fontSize: 12, marginTop: 10 },

  footer: { color: "#7a7a7a", textAlign: "center", marginTop: 16, fontSize: 12 },
});

export default HomeScreen;
