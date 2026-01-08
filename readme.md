# Worlds Laziest Website Generator

## AI take the wheel! 🚗
What happens when you just let go and push whatever AI slop straight to production. Do not pass go, do not collect $200. This... this is what happens.

This is a 24 line codebase that will generate any single page app with functional javascript and decent CSS. 4 lines are just prompt so like really its 20 lines of javascript. I picked Deno to run this because I thought it'd be cool but you could have done this with express or something and gotten similar results with even less code maybe.

Lets just skip CI/CD, tests, code review, and all that crap. In fact, why even use a framework or copilot? Just have the AI honk whatever it was going to stick into your editor directly to the end user!

When you don't care exactly how a problem gets solved or how a page looks, you only care about whether it can collect data, send sane looking requests to update state, or show a user something important, you can do a lot of things really fast. Maybe thats the future of the internet - some kind of vibe driven experience that takes in a user's preferences through some config from a browser, updates a prompt on the server, and generates a likeable website where the user and the backend can exchange important information. 

It'll be interesting to see if the users of the future care more about consistency or hyper-tailored experiences or neither as long as the job to be done is done.

## Running this jalopy
This uses Deno. If you have it: `deno run -N -E main.ts`. If not `npx deno run -N -E main.ts`

Make sure you have an `OPENAI_API_KEY` in your environment.