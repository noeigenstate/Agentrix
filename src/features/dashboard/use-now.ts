import { useEffect, useState } from 'react';

// The current time, re-read every second: what the page shows as elapsed or as age moves without asking the main process for anything.
export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}
