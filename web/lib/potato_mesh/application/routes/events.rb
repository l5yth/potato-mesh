# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# frozen_string_literal: true

require "json"

module PotatoMesh
  module App
    module Routes
      # Server-Sent Events endpoint that streams thin "this collection changed"
      # notifications from {PotatoMesh::App::PubSub} to dashboard clients
      # (SPEC.md +PS2+). The stream is **read-only** — it accepts no body and
      # writes nothing to the database; it merely tells the client to re-run its
      # existing delta fetch, so the apex (I) and the POST-only intake rule
      # (§3.3) are untouched.
      #
      # The streaming loop is factored into {pump} (and its {write_batch} /
      # {format_event} helpers) so it can be unit-tested deterministically with a
      # fake +out+ and an injected clock, without driving the full Rack streaming
      # stack.
      module Events
        # SSE +event:+ name carried by every change notification.
        EVENT_NAME = "change"

        # Monotonic clock used to bound a connection's lifetime. Injectable so
        # tests can drive the deadline deterministically.
        DEFAULT_CLOCK = -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) }

        class << self
          # Serialise a single coalesced change into an SSE frame.
          #
          # The +hint+ is emitted only when present so the payload stays minimal
          # and never carries a stray +null+.
          #
          # @param change [Hash{Symbol => Object}] +{ collection:, hint: }+.
          # @return [String] a complete +event: change+ SSE frame.
          def format_event(change)
            payload = { collection: change[:collection] }
            payload[:hint] = change[:hint] unless change[:hint].nil?
            "event: #{EVENT_NAME}\ndata: #{JSON.generate(payload)}\n\n"
          end

          # Write a drained batch to the stream.
          #
          # An empty batch (a heartbeat tick) emits an SSE comment so the
          # connection stays warm and intermediaries do not buffer it; otherwise
          # each change is written as its own frame.
          #
          # @param out [#<<] the SSE output sink.
          # @param changes [Array<Hash{Symbol => Object}>] coalesced changes.
          # @return [void]
          def write_batch(out, changes)
            if changes.empty?
              out << ": keepalive\n\n"
            else
              changes.each { |change| out << format_event(change) }
            end
          end

          # Pump coalesced change events to +out+ until the client disconnects
          # or the connection's lifetime deadline elapses.
          #
          # Each iteration blocks up to +heartbeat+ seconds inside
          # {PubSub::Subscriber#drain}; a timeout yields an empty batch (one
          # heartbeat comment). A write to a vanished client raises, which is
          # swallowed so the request thread unwinds cleanly into its +ensure+.
          #
          # @param out [#<<, #closed?] the SSE output sink.
          # @param subscriber [PubSub::Subscriber] this client's mailbox.
          # @param heartbeat [Numeric] max seconds to block per drain.
          # @param deadline_at [Numeric] monotonic time to stop pumping.
          # @param clock [#call] monotonic clock source.
          # @return [void]
          def pump(out, subscriber, heartbeat:, deadline_at:, clock: DEFAULT_CLOCK)
            until out.closed? || clock.call >= deadline_at
              write_batch(out, subscriber.drain(timeout: heartbeat))
            end
          rescue IOError, Errno::EPIPE, Errno::ECONNRESET
            # The client vanished mid-write; stop pumping and let +ensure+ run.
            nil
          end

          # Register +GET /api/events+ on the application.
          #
          # @param app [Sinatra::Base] application receiving the route.
          # @return [void]
          def registered(app)
            app.get "/api/events" do
              # When live updates are disabled the endpoint behaves as absent so
              # the client silently falls back to its safety poll (PS8).
              halt 404 unless PotatoMesh::Config.live_updates_enabled?

              content_type "text/event-stream"
              headers "Cache-Control" => "no-cache", "X-Accel-Buffering" => "no"

              subscriber = begin
                  PotatoMesh::App::PubSub.subscribe
                rescue PotatoMesh::App::PubSub::CapacityError
                  halt 503, "live update capacity reached"
                end

              heartbeat = PotatoMesh::Config.sse_heartbeat_seconds
              deadline = Events::DEFAULT_CLOCK.call + PotatoMesh::Config.sse_max_lifetime_seconds

              # Plain +stream+ (not +:keep_open+): {pump} owns the loop, so when it
              # returns — at the lifetime deadline or on client disconnect —
              # Sinatra closes the response and the client's EventSource
              # reconnects (and resyncs). This also bounds the request thread.
              stream do |out|
                # An initial comment confirms the open stream and flushes headers.
                out << ": connected\n\n"
                Events.pump(out, subscriber, heartbeat: heartbeat, deadline_at: deadline)
              ensure
                PotatoMesh::App::PubSub.unsubscribe(subscriber)
              end
            end
          end
        end
      end
    end
  end
end
