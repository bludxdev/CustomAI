#!/data/data/com.androidharness.app/files/linux/bin/bash
# Линкер-обёртка для сборки под aarch64-linux-android в Termux.
# Termux clang не находит crt-объекты и builtins для android-target, поэтому
# подсказываем -B и -resource-dir, а также каталог с libunwind/liblog.
PREFIX="${PREFIX:-/data/data/com.androidharness.app/files/linux}"
exec "$PREFIX/bin/clang-21" \
  --target=aarch64-linux-android24 \
  -fuse-ld=lld \
  -B"$PREFIX/lib" \
  -resource-dir "$PREFIX/lib/clang/21" \
  -L"$PREFIX/lib" \
  -Wl,--allow-shlib-undefined \
  "$@"
