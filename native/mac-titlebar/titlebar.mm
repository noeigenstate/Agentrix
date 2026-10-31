#import <AppKit/AppKit.h>
#include <napi.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>

namespace {
constexpr CGFloat kVerticalOffset = 0;
constexpr CGFloat kButtonGap = 4;
constexpr CGFloat kTrafficLightGap = 16;
char kTitleObservation;

struct ClickState {
  napi_threadsafe_function callback = nullptr;
  std::atomic<bool> active{true};

  void stop() {
    if (active.exchange(false) && callback) {
      napi_release_threadsafe_function(callback, napi_tsfn_abort);
    }
  }
};

struct Click {
  std::shared_ptr<ClickState> state;
  std::string id;
};

// Node also drains this queue with a null environment during shutdown.
void DeliverClick(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<Click> click(static_cast<Click*>(data));
  if (!env || !callback || !click->state->active.load()) return;
  Napi::Function(env, callback).Call({Napi::String::New(env, click->id)});
}

NSRect ScreenFrame(NSView* view) {
  return [view.window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
}
}

@interface AgentrixTitlebar : NSTitlebarAccessoryViewController {
  __weak NSWindow* host_;
  NSButton* decisions_;
  NSButton* workspace_;
  BOOL decisionsSelected_;
  BOOL workspaceSelected_;
  BOOL layingOut_;
  BOOL observingTitle_;
  std::shared_ptr<ClickState> clicks_;
}
- (instancetype)initWithWindow:(NSWindow*)window clicks:(std::shared_ptr<ClickState>)clicks;
- (void)detach;
- (void)alignButtons;
- (void)setItem:(NSString*)identifier label:(NSString*)label toolTip:(NSString*)toolTip
    accessibilityLabel:(NSString*)accessibilityLabel selected:(BOOL)selected;
@end

@implementation AgentrixTitlebar
- (instancetype)initWithWindow:(NSWindow*)window clicks:(std::shared_ptr<ClickState>)clicks {
  self = [super initWithNibName:nil bundle:nil];
  if (!self) return nil;
  host_ = window;
  clicks_ = std::move(clicks);
  self.layoutAttribute = NSLayoutAttributeLeft;
  NSButton* light = [window standardWindowButton:NSWindowCloseButton];
  CGFloat height = light ? NSHeight(light.superview.bounds) : 40;
  self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, height)];
  decisions_ = [self buttonWithID:@"decisions"];
  workspace_ = [self buttonWithID:@"workspace"];
  [self.view addSubview:decisions_];
  [self.view addSubview:workspace_];
  NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
  for (NSNotificationName name in @[NSWindowDidResizeNotification, NSWindowDidMoveNotification,
      NSWindowDidChangeScreenNotification, NSWindowDidEnterFullScreenNotification,
      NSWindowDidExitFullScreenNotification]) {
    [center addObserver:self selector:@selector(windowLayoutChanged:) name:name object:window];
  }
  [center addObserver:self selector:@selector(windowWillClose:) name:NSWindowWillCloseNotification object:window];
  [window addObserver:self forKeyPath:@"title" options:0 context:&kTitleObservation];
  observingTitle_ = YES;
  return self;
}

- (NSButton*)buttonWithID:(NSString*)identifier {
  NSButton* button = [[NSButton alloc] initWithFrame:NSZeroRect];
  button.identifier = identifier;
  button.bezelStyle = NSBezelStyleToolbar;
  button.buttonType = NSButtonTypePushOnPushOff;
  button.controlSize = NSControlSizeSmall;
  button.font = [NSFont systemFontOfSize:NSFont.smallSystemFontSize];
  button.target = self;
  button.action = @selector(navigate:);
  return button;
}

- (void)viewDidLayout {
  [super viewDidLayout];
  [self alignButtons];
}

- (void)viewDidAppear {
  [super viewDidAppear];
  [self windowLayoutChanged:nil];
}

- (void)windowLayoutChanged:(NSNotification*)notification {
  [self alignButtons];
  // Electron also reapplies trafficLightPosition after setting the title.
  __weak AgentrixTitlebar* weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf alignButtons]; });
}

- (void)observeValueForKeyPath:(NSString*)keyPath ofObject:(id)object change:(NSDictionary*)change context:(void*)context {
  if (context == &kTitleObservation) [self windowLayoutChanged:nil];
  else [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)alignButtons {
  NSWindow* host = host_;
  NSView* view = self.view;
  if (layingOut_ || !host || !view.window) return;
  layingOut_ = YES;
  CGFloat start = 0;
  CGFloat center = NSMidY(view.bounds);
  NSButton* light = [host standardWindowButton:NSWindowZoomButton];
  if (light.window) {
    // Full screen can reparent the native strip: use screen coordinates across windows.
    NSRect frame = [view convertRect:[view.window convertRectFromScreen:ScreenFrame(light)] fromView:nil];
    start = std::max(CGFloat(0), NSMaxX(frame) + kTrafficLightGap);
    center = NSMidY(frame);
  }
  CGFloat x = start;
  for (NSButton* button in @[decisions_, workspace_]) {
    NSSize size = button.fittingSize;
    CGFloat width = std::max(CGFloat(54), size.width + 12);
    button.frame = NSMakeRect(x, center - size.height / 2 + kVerticalOffset, width, size.height);
    x += width + kButtonGap;
  }
  CGFloat width = x - kButtonGap;
  if (std::abs(NSWidth(view.frame) - width) > 0.5) {
    [view setFrameSize:NSMakeSize(width, NSHeight(view.frame))];
  }
  layingOut_ = NO;
}

- (void)setItem:(NSString*)identifier label:(NSString*)label toolTip:(NSString*)toolTip
    accessibilityLabel:(NSString*)accessibilityLabel selected:(BOOL)selected {
  NSButton* button = [identifier isEqualToString:@"decisions"] ? decisions_ : workspace_;
  button.title = label;
  button.toolTip = toolTip;
  button.accessibilityLabel = accessibilityLabel;
  button.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
  if (button == decisions_) decisionsSelected_ = selected;
  else workspaceSelected_ = selected;
}

- (void)navigate:(NSButton*)sender {
  // A dialog can reject navigation; only the renderer's next state selects a tab.
  decisions_.state = decisionsSelected_ ? NSControlStateValueOn : NSControlStateValueOff;
  workspace_.state = workspaceSelected_ ? NSControlStateValueOn : NSControlStateValueOff;
  if (!clicks_ || !clicks_->active.load()) return;
  auto* click = new Click{clicks_, sender.identifier.UTF8String};
  if (napi_call_threadsafe_function(clicks_->callback, click, napi_tsfn_nonblocking) != napi_ok) delete click;
}

- (void)windowWillClose:(NSNotification*)notification { [self detach]; }

- (void)stopObserving {
  if (observingTitle_) [host_ removeObserver:self forKeyPath:@"title" context:&kTitleObservation];
  observingTitle_ = NO;
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)detach {
  if (clicks_) clicks_->stop();
  [self stopObserving];
  decisions_.target = nil;
  workspace_.target = nil;
  NSWindow* host = host_;
  host_ = nil;
  NSUInteger index = [host.titlebarAccessoryViewControllers indexOfObjectIdenticalTo:self];
  if (host && index != NSNotFound) [host removeTitlebarAccessoryViewControllerAtIndex:index];
}

- (void)dealloc {
  if (clicks_) clicks_->stop();
  [self stopObserving];
}
@end

namespace {
struct NativeState {
  AgentrixTitlebar* controller = nil;
  bool cleanupRegistered = false;
};

void Cleanup(void* data) {
  auto* state = static_cast<NativeState*>(data);
  state->cleanupRegistered = false;
  [state->controller detach];
  state->controller = nil;
}

void Reset(Napi::Env env) {
  NativeState* state = env.GetInstanceData<NativeState>();
  if (state->cleanupRegistered) napi_remove_env_cleanup_hook(env, Cleanup, state);
  Cleanup(state);
}

bool MainThread(Napi::Env env) {
  if (NSThread.isMainThread) return true;
  Napi::Error::New(env, "mac-titlebar must run on the macOS main thread").ThrowAsJavaScriptException();
  return false;
}

Napi::Value Detach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!MainThread(env)) return env.Undefined();
  Reset(env);
  return env.Undefined();
}

Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!MainThread(env)) return env.Undefined();
  if (info.Length() != 2 || !info[0].IsBuffer() || !info[1].IsFunction()
      || info[0].As<Napi::Buffer<uint8_t>>().Length() != sizeof(void*)) {
    Napi::TypeError::New(env, "attach requires a native window handle Buffer and a callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!NSApp) {
    Napi::Error::New(env, "mac-titlebar requires an initialized macOS application").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  void* handle = nullptr;
  std::memcpy(&handle, info[0].As<Napi::Buffer<uint8_t>>().Data(), sizeof(handle));
  NSView* nativeView = (__bridge NSView*)handle;
  NSWindow* window = nativeView.window;
  if (!window) {
    Napi::Error::New(env, "native window handle has no window").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NativeState* state = env.GetInstanceData<NativeState>();
  Reset(env);
  auto clicks = std::make_shared<ClickState>();
  napi_status status = napi_create_threadsafe_function(env, info[1], nullptr,
      Napi::String::New(env, "Agentrix titlebar navigation"), 0, 1, nullptr, nullptr, nullptr,
      DeliverClick, &clicks->callback);
  if (status != napi_ok) {
    Napi::Error::New(env, "could not create titlebar callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  napi_unref_threadsafe_function(env, clicks->callback);
  // Cleanup hooks run before environment/TSFN finalizers; register after creating the TSFN.
  if (napi_add_env_cleanup_hook(env, Cleanup, state) != napi_ok) {
    clicks->stop();
    Napi::Error::New(env, "could not register titlebar cleanup").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  state->cleanupRegistered = true;
  @try {
    state->controller = [[AgentrixTitlebar alloc] initWithWindow:window clicks:clicks];
    [window addTitlebarAccessoryViewController:state->controller];
    [state->controller alignButtons];
  } @catch (NSException* exception) {
    clicks->stop();
    Reset(env);
    Napi::Error::New(env, exception.reason.UTF8String).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Update(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!MainThread(env)) return env.Undefined();
  if (info.Length() != 1 || !info[0].IsObject() || !info[0].As<Napi::Object>().Get("items").IsArray()) {
    Napi::TypeError::New(env, "update requires two titlebar items").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array items = info[0].As<Napi::Object>().Get("items").As<Napi::Array>();
  struct Item {
    std::string label, toolTip, accessibilityLabel;
    bool selected;
  } parsed[2];
  bool seen[2] = {false, false};
  bool valid = items.Length() == 2;
  for (uint32_t i = 0; valid && i < items.Length(); i++) {
    Napi::Value value = items.Get(i);
    if (!value.IsObject()) { valid = false; break; }
    Napi::Object item = value.As<Napi::Object>();
    Napi::Value id = item.Get("id"), label = item.Get("label"), selection = item.Get("selected");
    Napi::Value toolTip = item.Get("toolTip"), accessibilityLabel = item.Get("accessibilityLabel");
    if (!id.IsString() || !label.IsString() || !selection.IsBoolean()
        || (!toolTip.IsUndefined() && !toolTip.IsString())
        || (!accessibilityLabel.IsUndefined() && !accessibilityLabel.IsString())) { valid = false; break; }
    std::string name = id.As<Napi::String>().Utf8Value();
    int index = name == "decisions" ? 0 : name == "workspace" ? 1 : -1;
    if (index < 0 || seen[index]) { valid = false; break; }
    seen[index] = true;
    parsed[index].label = label.As<Napi::String>().Utf8Value();
    parsed[index].toolTip = toolTip.IsString() ? toolTip.As<Napi::String>().Utf8Value() : parsed[index].label;
    parsed[index].accessibilityLabel = accessibilityLabel.IsString() ? accessibilityLabel.As<Napi::String>().Utf8Value() : parsed[index].label;
    parsed[index].selected = selection.As<Napi::Boolean>().Value();
  }
  if (!valid) {
    Napi::TypeError::New(env, "update requires decisions and workspace items with label, selected and optional text metadata").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  AgentrixTitlebar* controller = env.GetInstanceData<NativeState>()->controller;
  @try {
    for (int i = 0; i < 2; i++) {
      const Item& item = parsed[i];
      [controller setItem:i == 0 ? @"decisions" : @"workspace"
          label:[NSString stringWithUTF8String:item.label.c_str()]
          toolTip:[NSString stringWithUTF8String:item.toolTip.c_str()]
          accessibilityLabel:[NSString stringWithUTF8String:item.accessibilityLabel.c_str()] selected:item.selected];
    }
    [controller alignButtons];
  } @catch (NSException* exception) {
    Napi::Error::New(env, exception.reason.UTF8String).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData(new NativeState());
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("update", Napi::Function::New(env, Update));
  exports.Set("detach", Napi::Function::New(env, Detach));
  return exports;
}
}

NODE_API_MODULE(mac_titlebar, Initialize)
