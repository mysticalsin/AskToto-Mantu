// metis-noconstrain — swizzle NSWindow constrainFrameRect:toScreen: to return the
// frame unchanged. Totos-Mac 8:47am ET live PASS: Hide 8×2 at Y=bounds.y (was 39).
//
// Two products from the same source (scripts/build-mac-helper.mjs):
//   libmetis-noconstrain.dylib  constructor runs on DYLD_INSERT (show-tree / adhoc only)
//   metis-noconstrain.node      N-API Init() runs the same swizzle (packaged, hardened-runtime)
//
// Packaged Electron cannot use DYLD_INSERT_LIBRARIES. index.ts loads the .node in-process
// before createWindow via process.dlopen / require.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#if METIS_NOCONSTRAIN_NAPI
#include <node_api.h>
#endif

static NSRect MetisUnconstrainedFrame(id self, SEL cmd, NSRect frameRect, NSScreen *screen) {
  (void)self;
  (void)cmd;
  (void)screen;
  return frameRect;
}

void metis_install_no_constrain(void) {
  static int once = 0;
  if (once) return;
  once = 1;
  Class cls = objc_getClass("NSWindow");
  if (!cls) return;
  SEL sel = sel_registerName("constrainFrameRect:toScreen:");
  Method method = class_getInstanceMethod(cls, sel);
  if (!method) return;
  method_setImplementation(method, (IMP)MetisUnconstrainedFrame);
}

__attribute__((constructor)) static void metis_noconstrain_ctor(void) {
  metis_install_no_constrain();
}

#if METIS_NOCONSTRAIN_NAPI
static napi_value metis_noconstrain_init(napi_env env, napi_value exports) {
  (void)env;
  metis_install_no_constrain();
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, metis_noconstrain_init)
#endif
