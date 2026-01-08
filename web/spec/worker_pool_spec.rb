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

require "spec_helper"
require "timeout"

RSpec.describe PotatoMesh::App::WorkerPool do
  def with_pool(size: 2, queue: 2, task_timeout: nil)
    pool = PotatoMesh::App::WorkerPool.new(
      size: size,
      max_queue: queue,
      task_timeout: task_timeout,
      name: "spec-pool",
    )
    yield pool
  ensure
    pool&.shutdown(timeout: 0.5)
  end

  describe "#schedule" do
    it "executes jobs asynchronously and exposes their return values" do
      with_pool do |pool|
        task = pool.schedule { 21 + 21 }
        expect(task.wait(timeout: 1)).to eq(42)
      end
    end

    it "fails tasks that exceed the configured timeout" do
      with_pool(task_timeout: 0.01) do |pool|
        task = pool.schedule { sleep 0.05; :late }
        expect { task.wait(timeout: 1) }.to raise_error(described_class::TaskTimeoutError)
      end
    end

    it "propagates exceptions raised by the job block" do
      with_pool do |pool|
        task = pool.schedule { raise ArgumentError, "boom" }
        expect { task.wait(timeout: 1) }.to raise_error(ArgumentError, "boom")
      end
    end

    it "raises an error when the queue is saturated" do
      with_pool(size: 1, queue: 1) do |pool|
        gate = Queue.new
        first_task = pool.schedule { gate.pop; :first }

        Timeout.timeout(1) do
          sleep 0.01 until gate.num_waiting.positive?
        end

        second_task = pool.schedule { gate.pop; :second }

        expect do
          pool.schedule { :third }
        end.to raise_error(described_class::QueueFullError)

        gate << nil
        gate << nil
        expect(first_task.wait(timeout: 1)).to eq(:first)
        expect(second_task.wait(timeout: 1)).to eq(:second)
      end
    end
  end

  describe "#shutdown" do
    it "prevents new work from being scheduled" do
      pool = described_class.new(size: 1, max_queue: 1, name: "spec-pool")
      pool.shutdown(timeout: 0.5)

      expect do
        pool.schedule { :after_shutdown }
      end.to raise_error(described_class::ShutdownError)
    ensure
      pool.shutdown(timeout: 0.5)
    end
  end

  describe PotatoMesh::App::WorkerPool::Task do
    it "raises a timeout when the job exceeds the provided deadline" do
      with_pool do |pool|
        task = pool.schedule { sleep 0.1; :done }
        expect do
          task.wait(timeout: 0.01)
        end.to raise_error(PotatoMesh::App::WorkerPool::TaskTimeoutError)
        expect(task.wait(timeout: 1)).to eq(:done)
      end
    end

    it "reports completion status" do
      with_pool do |pool|
        task = pool.schedule { :result }
        expect(task.complete?).to be(false)
        expect(task.wait(timeout: 1)).to eq(:result)
        expect(task.complete?).to be(true)
      end
    end
  end
end
