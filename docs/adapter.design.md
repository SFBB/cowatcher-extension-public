- We have two types of adapters, content and injected.
- Content is our final view to present to the user, and this means it is our most important care.
  It is the final node of the cause and effect, so its data might not be the latest but it is the most accurate. So content is our director of all behaviour.
- We see our design from the view of content. Content can have three types interfaces.
  1. Element Query which happens solely in content world.
  2. Low-frequency query to injected world.
  3. Low-frequency event notification from injected world.

  And there is another io specifically for high-frequency data

  4. document.dataset.

- For both 1 and 2, it is triggered by the content. For both 3 and 4, it is triggered by the injected.

  - For all content triggering interfaces, its return type should be tri-state which represents `data`, `null`, and `undefined`. `data` means we found our target result and return it. `null` means we confirmed we cannot find the target result and it is null. `undefined` means we still don't known if we can find it or not and please try again later.
    So when content calls those interfaces, it should try first and if the result is undefined it should schedule the next poll later until the result is not undefined anymore.
    Specifically for 2, since only content knows what it is asking for, so content, the caller, should pass the entity id to those interfaces as parameters like movie id. And since this is mostly an async calling (at least due to window message posting), the caller should guard the result's validity with comparing the calling movie id against current movie id.

  - For both 3 and 4, we don't know when it will arrive content and content should be the final director. So the payload of 3 and 4's interfaces must contain entity id like movie id to identify itself. And the content uses it to judge if it should drop it or accept it or cache it for later usage.

- All data type of 1-4's should be explicitly defined.
