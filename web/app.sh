#!/usr/bin/env bash

bundle install
ruby app.rb -p 41447 -o 127.0.0.1
