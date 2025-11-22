// screens/FlappyEscScreen.js
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableWithoutFeedback,
  TouchableOpacity,
  Dimensions,
  SafeAreaView,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useNavigation } from "@react-navigation/native";
import { Audio } from "expo-av"; // 🔊 sound for scoring

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

const GAME_WIDTH = SCREEN_WIDTH;
const GAME_HEIGHT = SCREEN_HEIGHT * 0.8;

// Bird
const BIRD_SIZE = 32;
const GRAVITY = 0.45;
const JUMP_VELOCITY = -8.5;

// Pipes
const PIPE_WIDTH = 60;
const PIPE_GAP = 150;
const PIPE_SPEED = 2.4;
const PIPE_INTERVAL_MS = 1700;

const STORAGE_KEY_BEST = "flappy_esc_best_score_v1";

const FlappyEscScreen = () => {
  const navigation = useNavigation();

  const [birdY, setBirdY] = useState(GAME_HEIGHT / 2);
  const [velocity, setVelocity] = useState(0);

  const [pipes, setPipes] = useState([]); // [{ id, x, gapY, counted }]
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);

  const [status, setStatus] = useState("ready"); // ready, running, over

  const frameTimerRef = useRef(null);
  const pipeTimerRef = useRef(null);

  // physics ref so interval always sees the latest value
  const velocityRef = useRef(0);

  // sound ref
  const scoreSoundRef = useRef(null);

  // load best score + sound once
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY_BEST);
        if (raw) {
          const n = Number(raw);
          if (!Number.isNaN(n)) setBestScore(n);
        }
      } catch {}

      try {
        // 🔊 make sure this path matches your actual asset
        const { sound } = await Audio.Sound.createAsync(
          require("../../assets/sounds/incoming.mp3")
        );
        scoreSoundRef.current = sound;
      } catch (e) {
        console.log("score sound load error:", e);
      }
    })();

    return () => {
      // unload sound on unmount
      if (scoreSoundRef.current) {
        scoreSoundRef.current.unloadAsync().catch(() => {});
      }
    };
  }, []);

  const playScoreSound = useCallback(async () => {
    try {
      if (!scoreSoundRef.current) return;
      await scoreSoundRef.current.replayAsync();
    } catch (e) {
      console.log("score sound play error:", e);
    }
  }, []);

  const getRandomGapY = () => {
    const margin = 60; // top and bottom safe zone
    const minY = margin + PIPE_GAP / 2;
    const maxY = GAME_HEIGHT - margin - PIPE_GAP / 2;
    return minY + Math.random() * (maxY - minY);
  };

  const stopLoop = useCallback(() => {
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (pipeTimerRef.current) {
      clearInterval(pipeTimerRef.current);
      pipeTimerRef.current = null;
    }
  }, []);

  const endGame = useCallback(() => {
    stopLoop();
    setStatus((prev) => (prev === "over" ? prev : "over"));
  }, [stopLoop]);

  const resetGameState = useCallback(() => {
    stopLoop();
    velocityRef.current = 0;
    setVelocity(0);
    setBirdY(GAME_HEIGHT / 2);
    setPipes([]);
    setScore(0);
    setStatus("ready");
  }, [stopLoop]);

  const startLoop = useCallback(() => {
    // physics loop
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);

    frameTimerRef.current = setInterval(() => {
      // bird physics
      setBirdY((prevY) => {
        let vPrev = velocityRef.current;
        let vNext = vPrev + GRAVITY;
        let yNext = prevY + vNext;

        // ceiling clamp
        if (yNext - BIRD_SIZE / 2 < 0) {
          yNext = BIRD_SIZE / 2;
          vNext = 0;
        }

        // floor clamp + game over
        if (yNext + BIRD_SIZE / 2 >= GAME_HEIGHT) {
          yNext = GAME_HEIGHT - BIRD_SIZE / 2;
          vNext = 0;
          velocityRef.current = vNext;
          setVelocity(vNext);
          endGame();
          return yNext;
        }

        velocityRef.current = vNext;
        setVelocity(vNext);
        return yNext;
      });

      // move pipes and drop off-screen ones
      setPipes((prev) => {
        const updated = prev
          .map((p) => ({ ...p, x: p.x - PIPE_SPEED }))
          .filter((p) => p.x + PIPE_WIDTH > 0);
        return updated;
      });
    }, 1000 / 60); // ~60fps

    // pipe generation loop
    if (pipeTimerRef.current) clearInterval(pipeTimerRef.current);
    pipeTimerRef.current = setInterval(() => {
      setPipes((prev) => {
        const gapY = getRandomGapY();
        const id =
          Date.now().toString() + "_" + Math.random().toString(36).slice(2);
        return [
          ...prev,
          {
            id,
            x: GAME_WIDTH,
            gapY,
            counted: false,
          },
        ];
      });
    }, PIPE_INTERVAL_MS);
  }, [endGame]);

  // collision + scoring watcher
  useEffect(() => {
    if (status !== "running") return;
    if (!pipes.length) return;

    const birdX = GAME_WIDTH * 0.25;

    let hit = false;
    let gainedScore = 0;

    const updated = pipes.map((p) => {
      const topPipeBottom = p.gapY - PIPE_GAP / 2;
      const bottomPipeTop = p.gapY + PIPE_GAP / 2;

      const birdLeft = birdX - BIRD_SIZE / 2;
      const birdRight = birdX + BIRD_SIZE / 2;
      const pipeLeft = p.x;
      const pipeRight = p.x + PIPE_WIDTH;

      const horizontalOverlap = birdRight > pipeLeft && birdLeft < pipeRight;
      const hitTop = birdY - BIRD_SIZE / 2 < topPipeBottom;
      const hitBottom = birdY + BIRD_SIZE / 2 > bottomPipeTop;

      if (horizontalOverlap && (hitTop || hitBottom)) {
        hit = true;
      }

      if (!p.counted && pipeRight < birdX) {
        gainedScore += 1;
        return { ...p, counted: true };
      }

      return p;
    });

    if (hit) {
      endGame();
    } else if (gainedScore > 0) {
      setPipes(updated);
      setScore((prev) => {
        const next = prev + gainedScore;
        setBestScore((prevBest) => {
          const b = Math.max(prevBest, next);
          AsyncStorage.setItem(STORAGE_KEY_BEST, String(b)).catch(() => {});
          return b;
        });
        return next;
      });

      // 🔊 play sound once per frame with score gain
      playScoreSound();
    }
  }, [pipes, birdY, status, endGame, playScoreSound]);

  // clean timers on unmount
  useEffect(() => {
    return () => {
      stopLoop();
    };
  }, [stopLoop]);

  const handleTap = () => {
    if (status === "ready") {
      setStatus("running");
      velocityRef.current = JUMP_VELOCITY;
      setVelocity(JUMP_VELOCITY);
      startLoop();
      return;
    }

    if (status === "running") {
      velocityRef.current = JUMP_VELOCITY;
      setVelocity(JUMP_VELOCITY);
      return;
    }

    if (status === "over") {
      resetGameState();
      return;
    }
  };

  const birdX = GAME_WIDTH * 0.25;

  const handleBackHome = () => {
    // if you have a specific home route, you can use:
    // navigation.navigate("Home");
    navigation.goBack();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={handleBackHome} style={styles.backButton}>
          <Text style={styles.backIcon}>←</Text>
          <Text style={styles.backText}>Home</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.title}>Flappy ESC</Text>
          <Text style={styles.subtitle}>
            Tap to jump. Fly the coin through the pipes.
          </Text>
        </View>
      </View>

      <TouchableWithoutFeedback onPress={handleTap}>
        <View style={styles.container}>
          <View style={styles.scoreRow}>
            <Text style={styles.scoreText}>Score: {score}</Text>
            <Text style={styles.bestText}>Best: {bestScore}</Text>
          </View>

          <View style={styles.gameBox}>
            {/* bird */}
            <View
              style={[
                styles.bird,
                {
                  left: birdX - BIRD_SIZE / 2,
                  top: birdY - BIRD_SIZE / 2,
                },
              ]}
            >
              <Text style={styles.birdEmoji}>🪙</Text>
            </View>

            {/* pipes */}
            {pipes.map((p) => {
              const topHeight = p.gapY - PIPE_GAP / 2;
              const bottomTop = p.gapY + PIPE_GAP / 2;
              const bottomHeight = GAME_HEIGHT - bottomTop;

              return (
                <React.Fragment key={p.id}>
                  <View
                    style={[
                      styles.pipe,
                      {
                        left: p.x,
                        top: 0,
                        height: topHeight,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.pipe,
                      {
                        left: p.x,
                        top: bottomTop,
                        height: bottomHeight,
                      },
                    ]}
                  />
                </React.Fragment>
              );
            })}

            {/* overlays */}
            {status === "ready" && (
              <View style={styles.overlayCenter}>
                <Text style={styles.overlayTitle}>Tap to start</Text>
                <Text style={styles.overlayText}>Keep the ESC coin flying</Text>
              </View>
            )}

            {status === "over" && (
              <View style={styles.overlayCenter}>
                <Text style={styles.overlayTitle}>Game Over</Text>
                <Text style={styles.overlayText}>
                  Tap anywhere to try again
                </Text>
              </View>
            )}
          </View>

          <Text style={styles.hint}>
            Tap anywhere in the play area to jump. Use the top-left button to
            exit back home.
          </Text>
        </View>
      </TouchableWithoutFeedback>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#050509",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    backgroundColor: "#050509",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "#10121b",
    borderWidth: 1,
    borderColor: "#292c3a",
  },
  backIcon: {
    color: "#f5f5f5",
    fontSize: 14,
    marginRight: 4,
  },
  backText: {
    color: "#f5f5f5",
    fontSize: 13,
    fontWeight: "600",
  },
  headerCenter: {
    flex: 1,
    marginLeft: 10,
  },
  container: {
    flex: 1,
    alignItems: "center",
    paddingTop: 6,
    backgroundColor: "#050509",
  },
  title: {
    color: "#FFD700",
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: "#bfbfc6",
    fontSize: 12,
    marginTop: 2,
  },
  scoreRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: GAME_WIDTH - 32,
    marginTop: 4,
  },
  scoreText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  bestText: {
    color: "#FFD700",
    fontSize: 16,
    fontWeight: "700",
  },
  gameBox: {
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    marginTop: 10,
    backgroundColor: "#0b0c11",
    borderColor: "#22242e",
    borderWidth: 1,
    overflow: "hidden",
  },
  bird: {
    position: "absolute",
    width: BIRD_SIZE,
    height: BIRD_SIZE,
    borderRadius: BIRD_SIZE / 2,
    backgroundColor: "#ffb74d",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#ffe082",
  },
  birdEmoji: {
    fontSize: 20,
  },
  pipe: {
    position: "absolute",
    width: PIPE_WIDTH,
    backgroundColor: "#39c16c",
    borderColor: "#2f8f46",
    borderWidth: 2,
  },
  overlayCenter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: GAME_HEIGHT / 2 - 40,
    alignItems: "center",
  },
  overlayTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "800",
  },
  overlayText: {
    color: "#c7c7ce",
    fontSize: 13,
    marginTop: 6,
  },
  hint: {
    color: "#777",
    fontSize: 11,
    marginTop: 10,
    paddingHorizontal: 16,
    textAlign: "center",
  },
});

export default FlappyEscScreen;
