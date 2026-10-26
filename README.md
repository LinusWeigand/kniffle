# Kniffel

Play Kniffel online with friends. No sign-up, no server to run: open the page, create a game, send the link.

**Play:** https://linusweigand.github.io/kniffle/

- 1–6 players, German/English
- The host's browser runs the game. Messages are relayed through a public MQTT broker (HiveMQ) over secure WebSockets, so it works on any network
- Reloading the tab rejoins the game (the host's tab must stay open)
- Design based on `DESIGN.md` (Apple, via `npx getdesign@latest add apple`)

Run locally: `python3 -m http.server` and open http://localhost:8000.
