#import <AppKit/AppKit.h>
#include <napi.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
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

struct TitlebarStyle {
  CGFloat height, paddingX, gap, itemGap, radius, iconSize, focusWidth, focusOffset;
  CGFloat badgeMinWidth, badgePaddingX, badgeHeight;
  NSFont* font = nil;
  NSFont* badgeFont = nil;
  NSColor* text = nil;
  NSColor* textSelected = nil;
  NSColor* hover = nil;
  NSColor* selected = nil;
  NSColor* badge = nil;
  NSColor* badgeText = nil;
  NSColor* focus = nil;
  NSImage* icons[2][2] = {};
};

bool ReadObject(Napi::Object parent, const char* name, Napi::Object& result) {
  Napi::Value value = parent.Get(name);
  if (!value.IsObject() || value.IsArray()) return false;
  result = value.As<Napi::Object>();
  return true;
}

bool ReadNumber(Napi::Object parent, const char* name, CGFloat& result, bool positive = false, CGFloat maximum = 512) {
  Napi::Value value = parent.Get(name);
  if (!value.IsNumber()) return false;
  double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 || (positive && number == 0) || number > maximum) return false;
  result = number;
  return true;
}

NSColor* ReadColor(Napi::Value value) {
  if (!value.IsString()) return nil;
  std::string hex = value.As<Napi::String>().Utf8Value();
  if (hex.empty() || hex[0] != '#') return nil;
  if (hex.size() == 4 || hex.size() == 5) {
    std::string expanded = "#";
    for (size_t i = 1; i < hex.size(); i++) expanded.append(2, hex[i]);
    hex = expanded;
  }
  if (hex.size() != 7 && hex.size() != 9) return nil;
  if (hex.find_first_not_of("0123456789abcdefABCDEF", 1) != std::string::npos) return nil;
  unsigned long long rgba = std::strtoull(hex.c_str() + 1, nullptr, 16);
  if (hex.size() == 7) rgba = (rgba << 8) | 255;
  return [NSColor colorWithSRGBRed:((rgba >> 24) & 255) / 255.0 green:((rgba >> 16) & 255) / 255.0
      blue:((rgba >> 8) & 255) / 255.0 alpha:(rgba & 255) / 255.0];
}

NSBitmapImageRep* ReadIcon(Napi::Value value) {
  if (!value.IsString()) return nil;
  std::string url = value.As<Napi::String>().Utf8Value();
  constexpr char prefix[] = "data:image/png;base64,";
  if (url.size() > 256 * 1024 || url.compare(0, sizeof(prefix) - 1, prefix) != 0) return nil;
  NSData* data = [[NSData alloc] initWithBase64EncodedString:
      [NSString stringWithUTF8String:url.c_str() + sizeof(prefix) - 1] options:0];
  constexpr uint8_t signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (data.length < 33 || std::memcmp(data.bytes, signature, sizeof(signature)) != 0) return nil;
  const auto* bytes = static_cast<const uint8_t*>(data.bytes);
  for (size_t offset : {16, 20}) {
    uint32_t size = (uint32_t(bytes[offset]) << 24) | (uint32_t(bytes[offset + 1]) << 16)
        | (uint32_t(bytes[offset + 2]) << 8) | bytes[offset + 3];
    if (size == 0 || size > 1024) return nil;
  }
  @try {
    NSBitmapImageRep* image = [[NSBitmapImageRep alloc] initWithData:data];
    return image.hasAlpha && image.CGImage ? image : nil;
  } @catch (NSException* exception) {
    // A corrupt mask must leave the last valid style and navigation intact.
    return nil;
  }
}

NSImage* TintIcon(CGImageRef mask, NSColor* color, CGFloat size) {
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(nullptr, CGImageGetWidth(mask), CGImageGetHeight(mask), 8, 0,
      space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  if (!context) return nil;
  CGRect rect = CGRectMake(0, 0, CGImageGetWidth(mask), CGImageGetHeight(mask));
  CGContextClipToMask(context, rect, mask);
  CGContextSetFillColorWithColor(context, color.CGColor);
  CGContextFillRect(context, rect);
  CGImageRef tinted = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  if (!tinted) return nil;
  NSImage* image = [[NSImage alloc] initWithCGImage:tinted size:NSMakeSize(size, size)];
  CGImageRelease(tinted);
  return image;
}

NSFont* SystemFont(CGFloat size, CGFloat weight) {
  const CGFloat weights[] = {NSFontWeightUltraLight, NSFontWeightThin, NSFontWeightLight, NSFontWeightRegular,
      NSFontWeightMedium, NSFontWeightSemibold, NSFontWeightBold, NSFontWeightHeavy, NSFontWeightBlack};
  return [NSFont systemFontOfSize:size weight:weights[std::clamp(int(std::round(weight / 100)) - 1, 0, 8)]];
}

std::shared_ptr<const TitlebarStyle> ReadStyle(Napi::Value value) {
  if (!value.IsObject() || value.IsArray()) return {};
  Napi::Object root = value.As<Napi::Object>(), font, metrics, badge, colors, icons;
  CGFloat scale, fontSize, weight, badgeFontSize;
  if (!ReadNumber(root, "scale", scale, true, 4) || !ReadObject(root, "font", font)
      || !ReadNumber(font, "size", fontSize, true) || !ReadNumber(font, "weight", weight, true, 900) || weight < 100
      || !ReadObject(root, "metrics", metrics) || !ReadObject(metrics, "badge", badge)
      || !ReadObject(root, "colors", colors) || !ReadObject(root, "icons", icons)) return {};
  auto style = std::make_shared<TitlebarStyle>();
  struct Dimension { const char* name; CGFloat* result; bool positive; };
  const Dimension dimensions[] = {{"height", &style->height, true}, {"paddingX", &style->paddingX, false},
      {"gap", &style->gap, false}, {"itemGap", &style->itemGap, false}, {"radius", &style->radius, false},
      {"iconSize", &style->iconSize, true}, {"focusWidth", &style->focusWidth, false},
      {"focusOffset", &style->focusOffset, false}};
  for (const Dimension& field : dimensions) {
    if (!ReadNumber(metrics, field.name, *field.result, field.positive)) return {};
    *field.result *= scale;
  }
  if (!ReadNumber(badge, "minWidth", style->badgeMinWidth, true)
      || !ReadNumber(badge, "paddingX", style->badgePaddingX)
      || !ReadNumber(badge, "height", style->badgeHeight, true)
      || !ReadNumber(badge, "fontSize", badgeFontSize, true)) return {};
  style->badgeMinWidth *= scale;
  style->badgePaddingX *= scale;
  style->badgeHeight *= scale;
  struct Color { const char* name; NSColor* __strong* result; };
  const Color colorFields[] = {{"text", &style->text}, {"textSelected", &style->textSelected}, {"hover", &style->hover},
      {"selected", &style->selected}, {"badge", &style->badge}, {"badgeText", &style->badgeText}, {"focus", &style->focus}};
  for (const Color& field : colorFields) {
    *field.result = ReadColor(colors.Get(field.name));
    if (!*field.result) return {};
  }
  const char* names[] = {"decisions", "workspace"};
  for (int i = 0; i < 2; i++) {
    NSBitmapImageRep* mask = ReadIcon(icons.Get(names[i]));
    if (!mask) return {};
    style->icons[i][0] = TintIcon(mask.CGImage, style->text, style->iconSize);
    style->icons[i][1] = TintIcon(mask.CGImage, style->textSelected, style->iconSize);
    if (!style->icons[i][0] || !style->icons[i][1]) return {};
  }
  style->font = SystemFont(fontSize * scale, weight);
  style->badgeFont = SystemFont(badgeFontSize * scale, weight);
  return style;
}
}

@interface AgentrixNavButton : NSButton {
  std::shared_ptr<const TitlebarStyle> style_;
  NSString* label_;
  NSString* badgeText_;
  NSTrackingArea* tracking_;
  BOOL selected_;
  BOOL hovered_;
  BOOL keyboardFocus_;
  NSUInteger icon_;
}
@property(nonatomic, readonly) BOOL selected;
@property(nonatomic, readonly) NSSize contentSize;
@property(nonatomic, readonly) CGFloat itemGap;
@property(nonatomic, readonly) CGFloat focusOutset;
- (void)setLabel:(NSString*)label count:(uint64_t)count selected:(BOOL)selected;
- (void)applyStyle:(std::shared_ptr<const TitlebarStyle>)style icon:(NSUInteger)icon;
- (void)drawFocusRingInView:(NSView*)view;
@end

@implementation AgentrixNavButton
- (BOOL)isFlipped { return YES; }
- (BOOL)wantsUpdateLayer { return style_ ? NO : super.wantsUpdateLayer; }
- (BOOL)allowsVibrancy { return style_ ? NO : super.allowsVibrancy; }
- (BOOL)acceptsFirstResponder { return self.enabled; }
- (BOOL)selected { return selected_; }
- (CGFloat)itemGap { return style_ ? style_->itemGap : kButtonGap; }
- (CGFloat)focusOutset { return style_ ? style_->focusOffset + style_->focusWidth : 0; }

- (void)setLabel:(NSString*)label count:(uint64_t)count selected:(BOOL)selected {
  label_ = [label copy];
  badgeText_ = count ? [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(count)] : @"";
  self.title = count ? [NSString stringWithFormat:@"%@ %@", label_, badgeText_] : label_;
  selected_ = selected;
  self.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
  self.needsDisplay = YES;
  self.superview.needsDisplay = YES;
}

- (void)applyStyle:(std::shared_ptr<const TitlebarStyle>)style icon:(NSUInteger)icon {
  style_ = std::move(style);
  icon_ = icon;
  self.font = style_->font;
  self.focusRingType = NSFocusRingTypeNone;
  [self updateTrackingAreas];
  self.needsDisplay = YES;
  self.superview.needsDisplay = YES;
}

- (CGFloat)badgeWidth {
  CGFloat textWidth = [badgeText_ sizeWithAttributes:@{NSFontAttributeName: style_->badgeFont}].width;
  return std::max(style_->badgeMinWidth, textWidth + 2 * style_->badgePaddingX);
}

- (NSSize)contentSize {
  if (!style_) {
    NSSize size = super.fittingSize;
    return NSMakeSize(std::max(CGFloat(54), size.width + 12), size.height);
  }
  CGFloat labelWidth = [label_ sizeWithAttributes:@{NSFontAttributeName: style_->font}].width;
  CGFloat width = 2 * style_->paddingX + style_->iconSize + style_->gap + labelWidth;
  if (badgeText_.length) width += style_->gap + self.badgeWidth;
  return NSMakeSize(width, style_->height);
}

- (void)drawRect:(NSRect)dirtyRect {
  if (!style_) { [super drawRect:dirtyRect]; return; }
  const TitlebarStyle& style = *style_;
  NSColor* fill = selected_ ? style.selected : hovered_ ? style.hover : nil;
  if (fill) {
    [fill setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:style.radius yRadius:style.radius] fill];
  }
  BOOL primary = selected_ || hovered_;
  NSColor* text = primary ? style.textSelected : style.text;
  CGFloat x = style.paddingX;
  [style.icons[icon_][primary ? 1 : 0] drawInRect:NSMakeRect(x, (style.height - style.iconSize) / 2,
      style.iconSize, style.iconSize) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver
      fraction:1 respectFlipped:YES hints:nil];
  x += style.iconSize + style.gap;
  NSDictionary* attributes = @{NSFontAttributeName: style.font, NSForegroundColorAttributeName: text};
  NSSize labelSize = [label_ sizeWithAttributes:attributes];
  [label_ drawAtPoint:NSMakePoint(x, (style.height - labelSize.height) / 2) withAttributes:attributes];
  if (!badgeText_.length) return;
  NSRect badge = NSMakeRect(x + labelSize.width + style.gap, (style.height - style.badgeHeight) / 2,
      self.badgeWidth, style.badgeHeight);
  [style.badge setFill];
  [[NSBezierPath bezierPathWithRoundedRect:badge xRadius:style.badgeHeight / 2 yRadius:style.badgeHeight / 2] fill];
  NSDictionary* badgeAttributes = @{NSFontAttributeName: style.badgeFont, NSForegroundColorAttributeName: style.badgeText};
  NSSize badgeSize = [badgeText_ sizeWithAttributes:badgeAttributes];
  [badgeText_ drawAtPoint:NSMakePoint(NSMidX(badge) - badgeSize.width / 2, NSMidY(badge) - badgeSize.height / 2)
      withAttributes:badgeAttributes];
}

- (void)drawFocusRingInView:(NSView*)view {
  if (!style_ || !keyboardFocus_ || self.window.firstResponder != self || style_->focusWidth == 0) return;
  CGFloat outset = style_->focusOffset + style_->focusWidth / 2;
  NSRect rect = NSInsetRect([self convertRect:self.bounds toView:view], -outset, -outset);
  NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:rect
      xRadius:style_->radius + outset yRadius:style_->radius + outset];
  path.lineWidth = style_->focusWidth;
  [style_->focus setStroke];
  [path stroke];
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (tracking_) [self removeTrackingArea:tracking_];
  tracking_ = nil;
  if (!style_) return;
  tracking_ = [[NSTrackingArea alloc] initWithRect:NSZeroRect
      options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil];
  [self addTrackingArea:tracking_];
  hovered_ = self.window && NSPointInRect([self convertPoint:self.window.mouseLocationOutsideOfEventStream fromView:nil], self.bounds);
  self.needsDisplay = YES;
}

- (void)mouseEntered:(NSEvent*)event { hovered_ = YES; self.needsDisplay = YES; }
- (void)mouseExited:(NSEvent*)event { hovered_ = NO; self.needsDisplay = YES; }

- (void)mouseDown:(NSEvent*)event {
  keyboardFocus_ = NO;
  self.superview.needsDisplay = YES;
  [super mouseDown:event];
}

- (void)keyDown:(NSEvent*)event {
  keyboardFocus_ = YES;
  self.superview.needsDisplay = YES;
  [super keyDown:event];
}

- (BOOL)becomeFirstResponder {
  if (![super becomeFirstResponder]) return NO;
  keyboardFocus_ = NSApp.currentEvent.type == NSEventTypeKeyDown || NSApp.currentEvent.type == NSEventTypeKeyUp
      || self.window.keyViewSelectionDirection != NSDirectSelection;
  self.superview.needsDisplay = YES;
  return YES;
}

- (BOOL)resignFirstResponder {
  if (![super resignFirstResponder]) return NO;
  keyboardFocus_ = NO;
  self.superview.needsDisplay = YES;
  return YES;
}
@end

// Draw the outline in the group so it is not clipped to a button's hit area.
@interface AgentrixNavGroup : NSView
@end
@implementation AgentrixNavGroup
- (void)drawRect:(NSRect)dirtyRect {
  for (AgentrixNavButton* button in self.subviews) [button drawFocusRingInView:self];
}
@end

@interface AgentrixTitlebar : NSTitlebarAccessoryViewController {
  __weak NSWindow* host_;
  AgentrixNavButton* decisions_;
  AgentrixNavButton* workspace_;
  BOOL layingOut_;
  BOOL observingTitle_;
  std::shared_ptr<ClickState> clicks_;
}
- (instancetype)initWithWindow:(NSWindow*)window clicks:(std::shared_ptr<ClickState>)clicks;
- (void)detach;
- (void)alignButtons;
- (void)applyStyle:(std::shared_ptr<const TitlebarStyle>)style;
- (void)setItem:(NSString*)identifier label:(NSString*)label toolTip:(NSString*)toolTip
    accessibilityLabel:(NSString*)accessibilityLabel count:(uint64_t)count selected:(BOOL)selected;
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
  self.view = [[AgentrixNavGroup alloc] initWithFrame:NSMakeRect(0, 0, 200, height)];
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

- (AgentrixNavButton*)buttonWithID:(NSString*)identifier {
  AgentrixNavButton* button = [[AgentrixNavButton alloc] initWithFrame:NSZeroRect];
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
  CGFloat outset = decisions_.focusOutset;
  CGFloat start = outset;
  CGFloat center = NSMidY(view.bounds);
  NSButton* light = [host standardWindowButton:NSWindowZoomButton];
  if (light.window) {
    // Full screen can reparent the native strip: use screen coordinates across windows.
    NSRect frame = [view convertRect:[view.window convertRectFromScreen:ScreenFrame(light)] fromView:nil];
    start = std::max(outset, NSMaxX(frame) + kTrafficLightGap);
    center = NSMidY(frame);
  }
  CGFloat x = start;
  for (AgentrixNavButton* button in @[decisions_, workspace_]) {
    NSSize size = button.contentSize;
    button.frame = NSMakeRect(x, center - size.height / 2 + kVerticalOffset, size.width, size.height);
    x += size.width + button.itemGap;
  }
  CGFloat width = x - workspace_.itemGap + outset;
  CGFloat height = std::max(NSHeight(view.frame), decisions_.contentSize.height + 2 * outset);
  if (std::abs(NSWidth(view.frame) - width) > 0.5 || std::abs(NSHeight(view.frame) - height) > 0.5) {
    [view setFrameSize:NSMakeSize(width, height)];
  }
  view.needsDisplay = YES;
  layingOut_ = NO;
}

- (void)applyStyle:(std::shared_ptr<const TitlebarStyle>)style {
  [decisions_ applyStyle:style icon:0];
  [workspace_ applyStyle:style icon:1];
}

- (void)setItem:(NSString*)identifier label:(NSString*)label toolTip:(NSString*)toolTip
    accessibilityLabel:(NSString*)accessibilityLabel count:(uint64_t)count selected:(BOOL)selected {
  AgentrixNavButton* button = [identifier isEqualToString:@"decisions"] ? decisions_ : workspace_;
  [button setLabel:label count:count selected:selected];
  button.toolTip = toolTip;
  button.accessibilityLabel = accessibilityLabel;
}

- (void)navigate:(NSButton*)sender {
  // A dialog can reject navigation; only the renderer's next state selects a tab.
  for (AgentrixNavButton* button in @[decisions_, workspace_]) {
    button.state = button.selected ? NSControlStateValueOn : NSControlStateValueOff;
  }
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
    uint64_t count = 0;
    bool selected;
  } parsed[2];
  bool seen[2] = {false, false};
  bool valid = items.Length() == 2;
  for (uint32_t i = 0; valid && i < items.Length(); i++) {
    Napi::Value value = items.Get(i);
    if (!value.IsObject()) { valid = false; break; }
    Napi::Object item = value.As<Napi::Object>();
    Napi::Value id = item.Get("id"), label = item.Get("label"), selection = item.Get("selected");
    Napi::Value toolTip = item.Get("toolTip"), accessibilityLabel = item.Get("accessibilityLabel"), count = item.Get("count");
    if (!id.IsString() || !label.IsString() || !selection.IsBoolean()
        || (!toolTip.IsUndefined() && !toolTip.IsString())
        || (!accessibilityLabel.IsUndefined() && !accessibilityLabel.IsString())
        || (!count.IsUndefined() && !count.IsNumber())) { valid = false; break; }
    std::string name = id.As<Napi::String>().Utf8Value();
    int index = name == "decisions" ? 0 : name == "workspace" ? 1 : -1;
    if (index < 0 || seen[index]) { valid = false; break; }
    seen[index] = true;
    if (count.IsNumber()) {
      double number = count.As<Napi::Number>().DoubleValue();
      if (!std::isfinite(number) || number < 0 || number > 9007199254740991.0 || std::floor(number) != number) {
        valid = false; break;
      }
      parsed[index].count = static_cast<uint64_t>(number);
    }
    parsed[index].label = label.As<Napi::String>().Utf8Value();
    parsed[index].toolTip = toolTip.IsString() ? toolTip.As<Napi::String>().Utf8Value() : parsed[index].label;
    parsed[index].accessibilityLabel = accessibilityLabel.IsString() ? accessibilityLabel.As<Napi::String>().Utf8Value() : parsed[index].label;
    parsed[index].selected = selection.As<Napi::Boolean>().Value();
  }
  if (!valid) {
    Napi::TypeError::New(env, "update requires decisions and workspace items with label, selected, optional text metadata and a nonnegative safe-integer count").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  AgentrixTitlebar* controller = env.GetInstanceData<NativeState>()->controller;
  if (!controller) return env.Undefined();
  @try {
    // An incomplete style must not replace the last working appearance or detach navigation.
    auto style = ReadStyle(info[0].As<Napi::Object>().Get("style"));
    if (style) [controller applyStyle:style];
    for (int i = 0; i < 2; i++) {
      const Item& item = parsed[i];
      [controller setItem:i == 0 ? @"decisions" : @"workspace"
          label:[NSString stringWithUTF8String:item.label.c_str()]
          toolTip:[NSString stringWithUTF8String:item.toolTip.c_str()]
          accessibilityLabel:[NSString stringWithUTF8String:item.accessibilityLabel.c_str()]
          count:item.count selected:item.selected];
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
