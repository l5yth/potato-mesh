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

module PotatoMesh
  module App
    # WorkerPool executes submitted blocks using a bounded set of Ruby threads.
    #
    # The pool enforces an upper bound on queued tasks, surfaces errors raised
    # by jobs, and supports graceful shutdown during application teardown.
    class WorkerPool
      # Raised when the worker pool queue has reached its configured capacity.
      class QueueFullError < StandardError; end

      # Raised when a task fails to complete before the requested timeout.
      class TaskTimeoutError < StandardError; end

      # Raised when scheduling occurs after the pool has been shut down.
      class ShutdownError < StandardError; end

      # Internal structure responsible for coordinating task completion.
      class Task
        # @return [Object, nil] value produced by the task block when available.
        attr_reader :value

        # @return [StandardError, nil] error raised by the task block when set.
        attr_reader :error

        def initialize
          @mutex = Mutex.new
          @condition = ConditionVariable.new
          @complete = false
          @value = nil
          @error = nil
        end

        # Mark the task as completed successfully.
        #
        # @param result [Object] value produced by the job.
        # @return [void]
        def fulfill(result)
          @mutex.synchronize do
            return if @complete

            @complete = true
            @value = result
            @condition.broadcast
          end
        end

        # Mark the task as failed with the provided error.
        #
        # @param failure [StandardError] exception raised while executing the job.
        # @return [void]
        def reject(failure)
          @mutex.synchronize do
            return if @complete

            @complete = true
            @error = failure
            @condition.broadcast
          end
        end

        # Wait for the task to complete, raising any stored failure.
        #
        # @param timeout [Numeric, nil] optional timeout in seconds.
        # @return [Object] the value produced by the job when successful.
        # @raise [TaskTimeoutError] when the timeout elapses prior to completion.
        # @raise [StandardError] when the job raised an exception.
        def wait(timeout: nil)
          deadline = timeout && monotonic_now + timeout

          @mutex.synchronize do
            until @complete
              if deadline
                remaining = deadline - monotonic_now
                raise TaskTimeoutError, "task deadline exceeded" if remaining <= 0

                @condition.wait(@mutex, remaining)
              else
                @condition.wait(@mutex)
              end
            end

            raise @error if @error

            @value
          end
        end

        # Check whether the task has finished executing.
        #
        # @return [Boolean] true when the task is complete.
        def complete?
          @mutex.synchronize { @complete }
        end

        private

        def monotonic_now
          Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end
      end

      STOP_SIGNAL = Object.new

      # @return [Array<Thread>] threads created to service the pool.
      attr_reader :threads

      # Initialize a worker pool using the supplied configuration.
      #
      # @param size [Integer] number of worker threads to spawn.
      # @param max_queue [Integer, nil] optional upper bound on queued jobs.
      # @param name [String] prefix assigned to worker thread names.
      def initialize(size:, max_queue: nil, name: "worker-pool")
        raise ArgumentError, "size must be positive" unless size.is_a?(Integer) && size.positive?

        @name = name
        @queue = max_queue ? SizedQueue.new(max_queue) : Queue.new
        @threads = []
        @stopped = false
        @mutex = Mutex.new
        spawn_workers(size)
      end

      # Determine whether the worker pool is still accepting work.
      #
      # @return [Boolean] true when the pool remains active.
      def alive?
        @mutex.synchronize { !@stopped }
      end

      # Submit a block of work for asynchronous execution.
      #
      # @yieldreturn [Object] result produced by the job block.
      # @return [Task] task tracking the asynchronous execution.
      # @raise [QueueFullError] when the queue cannot accept additional work.
      # @raise [ShutdownError] when the pool is no longer active.
      def schedule(&block)
        raise ArgumentError, "block required" unless block

        task = Task.new

        @mutex.synchronize do
          raise ShutdownError, "worker pool has been shut down" if @stopped

          begin
            @queue.push([task, block], true)
          rescue ThreadError => e
            raise QueueFullError, e.message
          end
        end

        task
      end

      # Stop accepting work and wait for the worker threads to finish.
      #
      # @param timeout [Numeric, nil] seconds to wait for each worker to exit.
      # @return [void]
      def shutdown(timeout: nil)
        threads = nil

        @mutex.synchronize do
          return if @stopped

          @stopped = true
          threads = @threads.dup
        end

        threads.each { @queue << STOP_SIGNAL }
        threads.each { |thread| thread.join(timeout) }
      end

      private

      def spawn_workers(size)
        size.times do |index|
          worker = Thread.new do
            Thread.current.name = "#{@name}-#{index}" if Thread.current.respond_to?(:name=)
            Thread.current.report_on_exception = false if Thread.current.respond_to?(:report_on_exception=)

            loop do
              task, block = @queue.pop
              break if task.equal?(STOP_SIGNAL)

              begin
                result = block.call
                task.fulfill(result)
              rescue StandardError => e
                task.reject(e)
              end
            end
          end

          @threads << worker
        end
      end
    end
  end
end
