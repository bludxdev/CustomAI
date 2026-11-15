# CustomAI

CustomAI — приложение для общения с AI API. В репозитории есть нативное приложение на Rust + Slint и исходная веб-версия.

## Скачать Android APK

APK собирается GitHub Actions для `arm64-v8a` (большинство современных Android-телефонов) и лежит:

- во вкладке [Releases](../../releases/latest) — при публикации тега `v*`;
- во вкладке [Actions](../../actions/workflows/android.yml) как artifact сборки (артефакты хранятся 90 дней).

Ручной запуск: Actions → **Android APK** → **Run workflow**. Новый релиз: `git tag v1.0.0 && git push origin v1.0.0`.

## Сборка APK

Приложение использует Rust/Slint Android Activity backend и [`cargo-apk2`](https://github.com/slint-ui/cargo-apk2). Workflow ставит Android SDK/NDK, Rust target `aarch64-linux-android`, собирает release APK и проверяет подпись через `apksigner`.

Локально (нужны Rust, Android SDK и NDK):

```sh
cargo install cargo-apk2 --version 1.5.0
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/27.2.12479018"
cargo apk2 build --release --target aarch64-linux-android --lib
```

Готовый файл: `target/release/apk/CustomAI.apk`.

Сборка в CI подписывается одноразовым debug-ключом, поэтому её можно ставить напрямую, но нельзя гарантировать обновление поверх версии, подписанной другим ключом. Для постоянных релизов добавьте собственный keystore в GitHub Secrets и подключите его в workflow.

Не храните API-ключи и keystore в репозитории. Введённый в приложении API-ключ сохраняется только в приватном хранилище приложения на устройстве.

## Состав

- `src/`, `ui/`, `Cargo.toml`, `build.rs` — Rust + Slint приложение.
- `index.html`, `js/`, `css/`, `fonts/`, `server.py` — веб-версия.
- `.github/workflows/android.yml` — сборка и публикация Android APK.

## Веб-версия

```sh
python3 server.py
```

Откройте `http://localhost:8080`.
