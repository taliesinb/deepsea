{
  description = "DeepSea for Linux: a desktop client for a DeepSea server, with loopback port forwarding";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      # The app and the one repository package it imports (packages/logs), at
      # their repository paths so `../../packages/logs` resolves as in a checkout.
      source = pkgs: pkgs.lib.fileset.toSource {
        root = ../..;
        fileset = pkgs.lib.fileset.unions [
          (pkgs.lib.fileset.difference ./. (pkgs.lib.fileset.unions [ ./flake.nix ./flake.lock ]))
          ../../packages/logs/index.mjs
          ../../packages/logs/package.json
        ];
      };
      package = pkgs: pkgs.stdenvNoCC.mkDerivation {
        pname = "deepsea-client";
        inherit version;
        src = source pkgs;
        nativeBuildInputs = [ pkgs.makeWrapper pkgs.copyDesktopItems ];
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          share=$out/share/deepsea-client
          mkdir -p $share/apps $share/packages
          cp -r apps/linux $share/apps/linux
          rm -rf $share/apps/linux/tests
          cp -r packages/logs $share/packages/logs
          # The system's tailscale CLI wins (it matches its daemon); ours is the fallback.
          makeWrapper ${pkgs.electron}/bin/electron $out/bin/deepsea-client \
            --add-flags $share/apps/linux \
            --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.tailscale pkgs.xdg-utils ]}
          install -Dm644 apps/linux/icon.svg $out/share/icons/hicolor/scalable/apps/io.github.taliesinb.deepsea.svg
          runHook postInstall
        '';
        desktopItems = [
          (pkgs.makeDesktopItem {
            name = "io.github.taliesinb.deepsea";
            desktopName = "DeepSea";
            genericName = "DeepSea client";
            comment = "A DeepSea server's GUI, with its loopback ports forwarded";
            exec = "deepsea-client";
            icon = "io.github.taliesinb.deepsea";
            startupWMClass = "DeepSea";
            categories = [ "Development" "Network" ];
          })
        ];
        meta = {
          description = "DeepSea for Linux: a desktop client for a DeepSea server";
          license = pkgs.lib.licenses.mit;
          mainProgram = "deepsea-client";
          platforms = systems;
        };
      };
    in {
      packages = forAllSystems (pkgs: { default = package pkgs; });

      # The Node tests and the Electron smoke test (Xvfb). Chromium's own
      # sandbox cannot nest inside the build sandbox, hence --no-sandbox here
      # only; the installed app never passes it.
      checks = forAllSystems (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        tests = pkgs.stdenvNoCC.mkDerivation {
          name = "deepsea-client-tests-${version}";
          src = source pkgs;
          nativeBuildInputs = [ pkgs.nodejs pkgs.electron pkgs.xvfb-run ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            cd apps/linux
            node --test --test-timeout=60000 tests/*.test.mjs
            xvfb-run -a electron --no-sandbox --disable-gpu tests/electron-smoke.mjs
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
      });
    };
}
