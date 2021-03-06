'use strict';

import * as Hapi from "hapi";
import * as Boom from "boom";
import {HoustonScheduler} from "./HoustonScheduler";

const server = new Hapi.Server();
server.connection({port: 80, routes: {cors: true}});

server.start((err) => {
  if (err) {
    throw err;
  }
  console.log('Server running at:', server.info.uri);
});

server.route({
  method: 'GET',
  path: '/',
  handler: function (request, reply) {
    reply(`
<html><body style="background-color:#5bbb88;font-family: helvetica;font-weight: 400;color: white;">
  <h1>Rollout API</h1>
  <a href="/upcoming?latitude=29.7982722&longitude=-95.3736702">Upcoming</a> 
  | 
  <a href="https://github.com/kentongray/rollout-server">Docs</a>
</body></html>
      `)
  }
});

server.route({
  method: 'GET',
  path: '/upcoming',
  handler: function (request, reply) {
    var scheduler = new HoustonScheduler({
      latitude: request.query.latitude, longitude: request.query.longitude
    });
    scheduler.getUpcomingEvents(request.query.days || 60).then((events) => {
      //convert moment day to friendly string (leaving serialization logic in here for now)
      const jsonEvents:any[] = events.map(event => (<any>Object).assign(event, { day: event.day.format("YYYY-MM-DD") }));

      reply(JSON.stringify({
        events: jsonEvents,
        schedule: scheduler.pickupDays
      }))
    }).catch((error) => {
      console.error("Error Loading Schedule:", request.query, error);
      reply(Boom.gatewayTimeout("Error Loading Schedule", error));
    });
  }
});