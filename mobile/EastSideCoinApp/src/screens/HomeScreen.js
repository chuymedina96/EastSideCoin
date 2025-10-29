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
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { AuthContext } from "../context/AuthProvider";

// 60617 (South Chicago / East Side / South Deering nearby)
const ZIP_60617_LAT = 41.7239;
const ZIP_60617_LON = -87.5550;

// Open-Meteo (no key) — request °F + mph
const OPEN_METEO = `https://api.open-meteo.com/v1/forecast?latitude=${ZIP_60617_LAT}&longitude=${ZIP_60617_LON}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago`;

const BRIDGES = [
  { id: "95th", name: "95th St Bridge (Calumet River)" },
  { id: "100th", name: "100th St Bridge (Calumet River)" },
  { id: "106th", name: "106th St Bridge (Calumet River)" },
  { id: "92nd", name: "92nd St Bridge (Ewing Ave)" },
];

const HomeScreen = () => {
  const { user } = useContext(AuthContext);

  const [greeting, setGreeting] = useState("Welcome");
  const [weather, setWeather] = useState(null);
  const [news, setNews] = useState([]);
  const [bridgeInfo, setBridgeInfo] = useState([]);
  const [traffic, setTraffic] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadWeather(), loadNews(), loadBridgeInfo(), loadTraffic()]);
      setLoading(false);
    })();
  }, [loadWeather, loadNews, loadBridgeInfo, loadTraffic]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadWeather(), loadNews(), loadBridgeInfo(), loadTraffic()]);
    setRefreshing(false);
  }, [loadWeather, loadNews, loadBridgeInfo, loadTraffic]);

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

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

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
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFD700" />
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

          {/* Weather Card */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardHeader}>60617 Weather</Text>
              <TouchableOpacity style={styles.smallBtn} onPress={onRefresh}>
                <Text style={styles.smallBtnText}>Refresh</Text>
              </TouchableOpacity>
            </View>

            {weather ? (
              <View style={styles.weatherRow}>
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
              </View>
            ) : (
              <ActivityIndicator />
            )}
          </View>

          {/* Chicago Headlines (horizontal) */}
          <View style={styles.card}>
            <Text style={styles.cardHeader}>Chicago Headlines</Text>
            {loading && news.length === 0 ? (
              <ActivityIndicator style={{ marginTop: 12 }} />
            ) : news.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                {news.map((item, idx) => (
                  <NewsCard item={item} idx={idx} key={`${idx}-${item.title}`} />
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.empty}>No headlines right now. Pull to refresh.</Text>
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
              We’re prototyping AIS-based predictions for East Side bridges (95th, 100th, 106th, 92nd/Ewing).
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
  tag: {
    color: "#FFD700",
    fontSize: 12,
    borderColor: "#3a3a3a",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },

  weatherRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  weatherTemp: { color: "#FFFFFF", fontSize: 44, fontWeight: "800", lineHeight: 46 },
  weatherSub: { color: "#BEBEBE", marginTop: 2, fontSize: 13 },

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

  trafficLine: { color: "#BEBEBE", fontSize: 13, marginTop: 3 },
  bold: { color: "#EEE", fontWeight: "700" },

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
