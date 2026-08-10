self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const visibleClient = windowClients.find((windowClient) => windowClient.visibilityState === "visible");
      if (visibleClient) return visibleClient.focus();
      if (windowClients[0]) return windowClients[0].focus();
      return self.clients.openWindow("/");
    })
  );
});